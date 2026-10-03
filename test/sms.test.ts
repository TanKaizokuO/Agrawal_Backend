import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import {
  ConsoleSmsSender,
  Msg91SmsSender,
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

describe("Msg91SmsSender", () => {
  it("sends request with correct URL, authkey header, template_id, recipient mobiles, and default otp var", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    const mockFetch: typeof fetch = (input, init) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedInit = init;
      const responseBody = JSON.stringify({
        type: "success",
        message: "Flow process started",
      });
      return Promise.resolve(
        new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const sender = new Msg91SmsSender({
      authKey: "test-auth-key-123",
      templateId: "tmpl-456",
      fetchImpl: mockFetch,
    });

    await sender.sendOtp("+919876543210", "654321");

    expect(capturedUrl).toBe("https://control.msg91.com/api/v5/flow");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authkey).toBe("test-auth-key-123");
    expect(headers["content-type"]).toBe("application/json");

    const bodyText = typeof capturedInit?.body === "string" ? capturedInit.body : "";
    const parsedBody = JSON.parse(bodyText) as {
      template_id: string;
      short_url: string;
      recipients: Array<{ mobiles: string; otp: string }>;
    };
    expect(parsedBody.template_id).toBe("tmpl-456");
    expect(parsedBody.short_url).toBe("0");
    expect(parsedBody.recipients).toEqual([
      {
        mobiles: "919876543210",
        otp: "654321",
      },
    ]);
  });

  it("uses custom otpVar when provided in options", async () => {
    let capturedBody: string | undefined;

    const mockFetch: typeof fetch = (_input, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ type: "success" }), { status: 200 }),
      );
    };

    const sender = new Msg91SmsSender({
      authKey: "test-auth-key",
      templateId: "tmpl-custom-var",
      otpVar: "custom_otp",
      fetchImpl: mockFetch,
    });

    await sender.sendOtp("+919123456789", "888999");

    const parsed = JSON.parse(capturedBody ?? "") as {
      recipients: Array<{ mobiles: string; custom_otp: string }>;
    };
    expect(parsed.recipients[0]).toEqual({
      mobiles: "919123456789",
      custom_otp: "888999",
    });
  });

  it("formats phone number without leading plus", async () => {
    let capturedBody: string | undefined;

    const mockFetch: typeof fetch = (_input, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ type: "success" }), { status: 200 }),
      );
    };

    const sender = new Msg91SmsSender({
      authKey: "test-auth-key",
      templateId: "tmpl-phone-test",
      fetchImpl: mockFetch,
    });

    await sender.sendOtp("919988776655", "112233");

    const parsed = JSON.parse(capturedBody ?? "") as {
      recipients: Array<{ mobiles: string }>;
    };
    expect(parsed.recipients[0]?.mobiles).toBe("919988776655");
  });

  it("fails when response HTTP status is non-2xx", async () => {
    const mockFetch: typeof fetch = () => {
      return Promise.resolve(
        new Response(JSON.stringify({ message: "Invalid credentials" }), {
          status: 401,
          statusText: "Unauthorized",
        }),
      );
    };

    const sender = new Msg91SmsSender({
      authKey: "wrong-key",
      templateId: "tmpl-error",
      fetchImpl: mockFetch,
    });

    await expect(sender.sendOtp("+919876543210", "123456")).rejects.toThrow(
      /MSG91 request failed with HTTP 401/,
    );
  });

  it("fails when response JSON body has type !== 'success'", async () => {
    const mockFetch: typeof fetch = () => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: "error",
            message: "Mobile number is blocked",
          }),
          { status: 200 },
        ),
      );
    };

    const sender = new Msg91SmsSender({
      authKey: "test-key",
      templateId: "tmpl-blocked",
      fetchImpl: mockFetch,
    });

    await expect(sender.sendOtp("+919876543210", "123456")).rejects.toThrow(
      /MSG91 delivery failed: Mobile number is blocked/,
    );
  });

  it("fails when response body is not valid JSON", async () => {
    const mockFetch: typeof fetch = () => {
      return Promise.resolve(
        new Response("Gateway Timeout", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    };

    const sender = new Msg91SmsSender({
      authKey: "test-key",
      templateId: "tmpl-invalid-json",
      fetchImpl: mockFetch,
    });

    await expect(sender.sendOtp("+919876543210", "123456")).rejects.toThrow(
      /MSG91 response was not valid JSON/,
    );
  });

  it("propagates AbortSignal to fetchImpl", async () => {
    let capturedSignal: AbortSignal | null | undefined;

    const mockFetch: typeof fetch = (_input, init) => {
      capturedSignal = init?.signal;
      return Promise.resolve(
        new Response(JSON.stringify({ type: "success" }), { status: 200 }),
      );
    };

    const sender = new Msg91SmsSender({
      authKey: "test-key",
      templateId: "tmpl-signal",
      timeoutMs: 5000,
      fetchImpl: mockFetch,
    });

    await sender.sendOtp("+919876543210", "123456");

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
  });
  it("validates required options in constructor", () => {
    expect(
      () =>
        new Msg91SmsSender({
          authKey: "",
          templateId: "tmpl-1",
        }),
    ).toThrow(/MSG91 auth key is required/);

    expect(
      () =>
        new Msg91SmsSender({
          authKey: "auth-1",
          templateId: "",
        }),
    ).toThrow(/MSG91 template ID is required/);

    expect(
      () =>
        new Msg91SmsSender({
          authKey: "auth-1",
          templateId: "tmpl-1",
          timeoutMs: -5,
        }),
    ).toThrow(/MSG91 timeout must be a positive integer/);
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
  it("returns Msg91SmsSender when smsProvider is msg91", () => {
    const sender = createSmsSender({
      smsProvider: "msg91",
      msg91AuthKey: "auth-key",
      msg91TemplateId: "tmpl-id",
    });

    expect(sender).toBeInstanceOf(Msg91SmsSender);
  });

  it("throws if msg91 credentials are missing when smsProvider is msg91", () => {
    expect(() =>
      createSmsSender({
        smsProvider: "msg91",
      }),
    ).toThrow(/MSG91_AUTH_KEY is required/);

    expect(() =>
      createSmsSender({
        smsProvider: "msg91",
        msg91AuthKey: "auth-key",
      }),
    ).toThrow(/MSG91_TEMPLATE_ID is required/);
  });

  it("returns ConsoleSmsSender when smsProvider is console", () => {
    const sender = createSmsSender({
      smsProvider: "console",
      nodeEnv: "development",
    });

    expect(sender).toBeInstanceOf(ConsoleSmsSender);
  });
});

describe("Configuration validation for SMS and OTP", () => {
  it("rejects console SMS provider in production", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseTestEnvironment(),
      NODE_ENV: "production",
      SMS_PROVIDER: "console",
      MSG91_AUTH_KEY: "auth-key",
      MSG91_TEMPLATE_ID: "tmpl-id",
    };

    let thrown: unknown;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const configError = thrown as ConfigError;
    const issue = configError.issues.find((i) => i.variable === "SMS_PROVIDER");
    expect(issue?.message).toMatch(/not permitted in production/i);
  });

  it("rejects missing MSG91 variables in production", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseTestEnvironment(),
      NODE_ENV: "production",
      SMS_PROVIDER: "msg91",
    };
    delete env.MSG91_AUTH_KEY;
    delete env.MSG91_TEMPLATE_ID;

    let thrown: unknown;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const configError = thrown as ConfigError;
    const authKeyIssue = configError.issues.find((i) => i.variable === "MSG91_AUTH_KEY");
    const templateIdIssue = configError.issues.find((i) => i.variable === "MSG91_TEMPLATE_ID");
    expect(authKeyIssue?.message).toMatch(/required in production/i);
    expect(templateIdIssue?.message).toMatch(/required in production/i);
  });

  it("accepts valid MSG91 configuration in production", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseTestEnvironment(),
      NODE_ENV: "production",
      SMS_PROVIDER: "msg91",
      MSG91_AUTH_KEY: "auth-key-valid",
      MSG91_TEMPLATE_ID: "tmpl-valid-123",
      MSG91_OTP_VAR: "custom_otp",
    };

    const config = loadConfig(env);
    expect(config.smsProvider).toBe("msg91");
    expect(config.msg91AuthKey).toBe("auth-key-valid");
    expect(config.msg91TemplateId).toBe("tmpl-valid-123");
    expect(config.msg91OtpVar).toBe("custom_otp");
  });

  it("accepts console provider outside production", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseTestEnvironment(),
      NODE_ENV: "development",
      SMS_PROVIDER: "console",
    };

    const config = loadConfig(env);
    expect(config.smsProvider).toBe("console");
    expect(config.msg91OtpVar).toBe("otp");
  });

  it("rejects missing MSG91 variables when SMS_PROVIDER=msg91 in development", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseTestEnvironment(),
      NODE_ENV: "development",
      SMS_PROVIDER: "msg91",
    };
    delete env.MSG91_AUTH_KEY;
    delete env.MSG91_TEMPLATE_ID;

    expect(() => loadConfig(env)).toThrow(/MSG91_AUTH_KEY/);
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
