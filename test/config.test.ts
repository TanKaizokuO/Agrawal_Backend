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
});
