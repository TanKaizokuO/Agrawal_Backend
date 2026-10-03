import type { Logger } from "pino";
import type { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import {
  ConsoleSmsSender,
  SnsSmsSender,
  createSmsSender,
} from "../src/modules/identity/sms/index.js";

function baseTestEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    APP_ENV: "local",
    DATABASE_URL: "postgresql://agrawal_app:password@localhost:5432/agrawal_test",
    DATABASE_MIGRATION_URL: "postgresql://postgres:password@localhost:5432/agrawal_test",
    FIREBASE_PROJECT_ID: "project",
    FIREBASE_SERVICE_ACCOUNT_JSON: "{}",
    RAZORPAY_KEY_ID: "key-id",
    RAZORPAY_KEY_SECRET: "key-secret",
    RAZORPAY_WEBHOOK_SECRET: "webhook-secret",
    PAYMENT_IDENTITY_HMAC_KEY: Buffer.alloc(32, 1).toString("base64"),
    OTP_HMAC_KEY: Buffer.alloc(32, 2).toString("base64"),
    S3_BUCKET: "bucket",
    GOOGLE_CLOUD_PROJECT: "project",
    GOOGLE_APPLICATION_CREDENTIALS_JSON: "{}",
    WEB_ORIGINS: "http://localhost:5173",
    EVENT_PASS_SIGNING_KEYS: "[]",
    SMS_PROVIDER: "console",
  };
}

const SNS_OPTIONS = {
  region: "ap-south-1",
  senderId: "AGRWAL",
  entityId: "1201000000000012345",
  templateId: "1207168000000054321",
  messageTemplate: "Your Agrawal Samaj verification code is {otp}. Valid for 5 minutes.",
};

function fakeSnsClient(send: (command: PublishCommand) => Promise<unknown>): SNSClient {
  return { send } as unknown as SNSClient;
}

describe("SnsSmsSender", () => {
  it("publishes the rendered DLT message to the phone with transactional DLT attributes", async () => {
    const commands: PublishCommand[] = [];
    const sender = new SnsSmsSender({
      ...SNS_OPTIONS,
      client: fakeSnsClient((command) => {
        commands.push(command);
        return Promise.resolve({ MessageId: "msg-1" });
      }),
    });

    await sender.sendOtp("+919876543210", "482913");

    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).toEqual({
      PhoneNumber: "+919876543210",
      Message: "Your Agrawal Samaj verification code is 482913. Valid for 5 minutes.",
      MessageAttributes: {
        "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
        "AWS.SNS.SMS.SenderID": { DataType: "String", StringValue: "AGRWAL" },
        "AWS.MM.SMS.EntityId": { DataType: "String", StringValue: "1201000000000012345" },
        "AWS.MM.SMS.TemplateId": { DataType: "String", StringValue: "1207168000000054321" },
      },
    });
  });

  it("propagates SNS errors so the challenge is rolled back", async () => {
    const sender = new SnsSmsSender({
      ...SNS_OPTIONS,
      client: fakeSnsClient(() => Promise.reject(new Error("Throttling"))),
    });

    await expect(sender.sendOtp("+919876543210", "123456")).rejects.toThrow(/Throttling/);
  });

  it("fails when SNS returns no MessageId", async () => {
    const sender = new SnsSmsSender({
      ...SNS_OPTIONS,
      client: fakeSnsClient(() => Promise.resolve({})),
    });

    await expect(sender.sendOtp("+919876543210", "123456")).rejects.toThrow(/no MessageId/);
  });

  it("validates required options in constructor", () => {
    expect(() => new SnsSmsSender({ ...SNS_OPTIONS, senderId: " " })).toThrow(/sender ID is required/);
    expect(() => new SnsSmsSender({ ...SNS_OPTIONS, entityId: "" })).toThrow(/entity ID is required/);
    expect(() => new SnsSmsSender({ ...SNS_OPTIONS, templateId: "" })).toThrow(/template ID is required/);
    expect(() => new SnsSmsSender({ ...SNS_OPTIONS, messageTemplate: "Code: 123" })).toThrow(
      /\{otp\} exactly once/,
    );
    expect(
      () => new SnsSmsSender({ ...SNS_OPTIONS, messageTemplate: "{otp} and {otp}" }),
    ).toThrow(/\{otp\} exactly once/);
  });
});

describe("ConsoleSmsSender", () => {
  it("logs the OTP code to logger outside production", async () => {
    const logEntries: Array<{ bindings: unknown; message: unknown }> = [];
    const mockLogger = {
      info: (bindings: unknown, message?: unknown) => {
        logEntries.push({ bindings, message });
      },
    };

    const sender = new ConsoleSmsSender({
      logger: mockLogger as unknown as Logger,
      isProduction: false,
    });

    await sender.sendOtp("+919876543210", "123456");

    expect(logEntries).toHaveLength(1);
    expect(logEntries[0]?.bindings).toEqual({
      phone: "+919876543210",
      code: "123456",
    });
  });

  it("throws error and refuses to send/log in production", async () => {
    const logSpy = vi.fn();
    const mockLogger = {
      info: logSpy,
    };

    const sender = new ConsoleSmsSender({
      logger: mockLogger as unknown as Logger,
      isProduction: true,
    });

    await expect(sender.sendOtp("+919876543210", "123456")).rejects.toThrow(
      /Console SMS provider is not permitted in production/,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("createSmsSender factory", () => {
  const snsConfig = {
    smsProvider: "sns" as const,
    awsRegion: "ap-south-1",
    snsSmsSenderId: "AGRWAL",
    snsSmsEntityId: "1201000000000012345",
    snsSmsTemplateId: "1207168000000054321",
    snsSmsOtpMessage: "Code {otp}",
  };

  it("returns SnsSmsSender when smsProvider is sns", () => {
    expect(createSmsSender(snsConfig)).toBeInstanceOf(SnsSmsSender);
  });

  it("throws if SNS settings are missing when smsProvider is sns", () => {
    expect(() => createSmsSender({ ...snsConfig, snsSmsSenderId: undefined })).toThrow(
      /SNS_SMS_SENDER_ID is required/,
    );
    expect(() => createSmsSender({ ...snsConfig, snsSmsOtpMessage: "" })).toThrow(
      /SNS_SMS_OTP_MESSAGE is required/,
    );
  });

  it("returns ConsoleSmsSender when smsProvider is console", () => {
    const sender = createSmsSender({
      smsProvider: "console",
      awsRegion: "ap-south-1",
      nodeEnv: "development",
    });

    expect(sender).toBeInstanceOf(ConsoleSmsSender);
  });
});

const VALID_SNS_ENV = {
  SNS_SMS_SENDER_ID: "AGRWAL",
  SNS_SMS_ENTITY_ID: "1201000000000012345",
  SNS_SMS_TEMPLATE_ID: "1207168000000054321",
  SNS_SMS_OTP_MESSAGE: "Your Agrawal Samaj verification code is {otp}. Valid for 5 minutes.",
};

function configIssues(env: NodeJS.ProcessEnv): ConfigError {
  let thrown: unknown;
  try {
    loadConfig(env);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  return thrown as ConfigError;
}

describe("Configuration validation for SMS and OTP", () => {
  it("rejects console SMS provider in production", () => {
    const configError = configIssues({
      ...baseTestEnvironment(),
      ...VALID_SNS_ENV,
      NODE_ENV: "production",
      SMS_PROVIDER: "console",
    });
    const issue = configError.issues.find((i) => i.variable === "SMS_PROVIDER");
    expect(issue?.message).toMatch(/not permitted in production/i);
  });

  it("rejects missing SNS variables in production", () => {
    const configError = configIssues({
      ...baseTestEnvironment(),
      NODE_ENV: "production",
      SMS_PROVIDER: "sns",
    });
    for (const variable of Object.keys(VALID_SNS_ENV)) {
      const issue = configError.issues.find((i) => i.variable === variable);
      expect(issue?.message).toMatch(/required in production/i);
    }
  });

  it("rejects an OTP message without exactly one {otp} placeholder", () => {
    const configError = configIssues({
      ...baseTestEnvironment(),
      ...VALID_SNS_ENV,
      SMS_PROVIDER: "sns",
      SNS_SMS_OTP_MESSAGE: "Your code is {#var#}",
    });
    const issue = configError.issues.find((i) => i.variable === "SNS_SMS_OTP_MESSAGE");
    expect(issue?.message).toMatch(/exactly once/);
  });

  it("accepts valid SNS configuration in production", () => {
    const config = loadConfig({
      ...baseTestEnvironment(),
      ...VALID_SNS_ENV,
      NODE_ENV: "production",
      SMS_PROVIDER: "sns",
    });
    expect(config.smsProvider).toBe("sns");
    expect(config.snsSmsSenderId).toBe("AGRWAL");
    expect(config.snsSmsEntityId).toBe("1201000000000012345");
    expect(config.snsSmsTemplateId).toBe("1207168000000054321");
    expect(config.snsSmsOtpMessage).toBe(VALID_SNS_ENV.SNS_SMS_OTP_MESSAGE);
  });

  it("accepts console provider outside production", () => {
    const config = loadConfig({
      ...baseTestEnvironment(),
      NODE_ENV: "development",
      SMS_PROVIDER: "console",
    });
    expect(config.smsProvider).toBe("console");
  });

  it("rejects missing SNS variables when SMS_PROVIDER=sns in development", () => {
    expect(() =>
      loadConfig({ ...baseTestEnvironment(), NODE_ENV: "development", SMS_PROVIDER: "sns" }),
    ).toThrow(/SNS_SMS_SENDER_ID/);
  });

  it("rejects the removed msg91 provider", () => {
    expect(() =>
      loadConfig({ ...baseTestEnvironment(), SMS_PROVIDER: "msg91" }),
    ).toThrow(/SMS_PROVIDER/);
  });

  it("rejects missing OTP_HMAC_KEY", () => {
    const env = baseTestEnvironment();
    delete env.OTP_HMAC_KEY;

    expect(() => loadConfig(env)).toThrow(/OTP_HMAC_KEY/);
  });

  it("rejects OTP_HMAC_KEY with invalid base64 encoding", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseTestEnvironment(),
      OTP_HMAC_KEY: "not-valid-base64!!@@##",
    };

    expect(() => loadConfig(env)).toThrow(/OTP_HMAC_KEY/);
  });

  it("rejects OTP_HMAC_KEY with decoded length under 32 bytes", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseTestEnvironment(),
      OTP_HMAC_KEY: Buffer.alloc(16).toString("base64"),
    };

    expect(() => loadConfig(env)).toThrow(/at least 32 bytes/);
  });

  it("accepts OTP_HMAC_KEY with decoded length of 32 bytes or more", () => {
    const env32: NodeJS.ProcessEnv = {
      ...baseTestEnvironment(),
      OTP_HMAC_KEY: Buffer.alloc(32).toString("base64"),
    };
    expect(loadConfig(env32).otpHmacKey).toBe(Buffer.alloc(32).toString("base64"));

    const env64: NodeJS.ProcessEnv = {
      ...baseTestEnvironment(),
      OTP_HMAC_KEY: Buffer.alloc(64).toString("base64"),
    };
    expect(loadConfig(env64).otpHmacKey).toBe(Buffer.alloc(64).toString("base64"));
  });
});
