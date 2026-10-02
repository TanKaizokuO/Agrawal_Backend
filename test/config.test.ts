import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function validEnvironment(): NodeJS.ProcessEnv {
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
    S3_BUCKET: "bucket",
    GOOGLE_CLOUD_PROJECT: "project",
    GOOGLE_APPLICATION_CREDENTIALS_JSON: "{}",
    WEB_ORIGINS: "http://localhost:5173",
    EVENT_PASS_SIGNING_KEYS: "[]",
  };
}

describe("loadConfig", () => {
  it("reads RETENTION_DAYS_PAYMENTS from the environment", () => {
    const config = loadConfig({ ...validEnvironment(), RETENTION_DAYS_PAYMENTS: "3000" });

    expect(config.retentionDaysPayments).toBe(3000);
  });

  it("defaults payment retention to eight years (ADR-0026 §5)", () => {
    expect(loadConfig(validEnvironment()).retentionDaysPayments).toBe(2920);
  });

  it("defaults registration payment to required", () => {
    expect(loadConfig(validEnvironment()).registrationPaymentRequired).toBe(true);
  });

  it("reads the explicit unpaid registration pilot policy", () => {
    expect(loadConfig({
      ...validEnvironment(),
      REGISTRATION_PAYMENT_REQUIRED: "false",
    }).registrationPaymentRequired).toBe(false);
  });

  it("requires WEB_ORIGINS instead of using a placeholder origin", () => {
    const environment = validEnvironment();
    environment.APP_ENV = "production";
    delete environment.WEB_ORIGINS;

    expect(() => loadConfig(environment)).toThrow(/WEB_ORIGINS/);
  });

  it("rejects a WEB_ORIGINS list without any origins", () => {
    expect(() =>
      loadConfig({ ...validEnvironment(), WEB_ORIGINS: ",  ," }),
    ).toThrow(/WEB_ORIGINS/);
  });

  it("requires NODE_ENV instead of defaulting to production", () => {
    const environment = validEnvironment();
    delete environment.NODE_ENV;

    expect(() => loadConfig(environment)).toThrow(/NODE_ENV/);
  });

});
