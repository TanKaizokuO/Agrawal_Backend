import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrincipalResolver } from "../src/http/auth.js";
import { AppError } from "../src/http/errors.js";
import { createApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { HealthResponse, ReadinessResponse } from "../src/openapi/registry.js";
import { getTestDatabase } from "./setup.js";

const WEB_ORIGIN = "https://register.example.test";

const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  requestId: z.string(),
});

const AcceptedResponse = z.object({
  accepted: z.literal(true),
});

type AppOptions = {
  readonly jobsReady?: boolean;
  readonly mountRoutes?: (app: Express) => void;
  readonly principalResolver?: PrincipalResolver;
};

function createFoundationApp(options: AppOptions = {}): Express {
  const { mountRoutes, principalResolver } = options;
  return createApp({
    config: { webOrigins: [WEB_ORIGIN] },
    database: getTestDatabase(),
    jobs: {
      isReady: () => Promise.resolve(options.jobsReady ?? true),
    },
    ...(mountRoutes === undefined ? {} : { mountRoutes }),
    ...(principalResolver === undefined ? {} : { principalResolver }),
  });
}

describe("M0 HTTP foundations", () => {
  it("reports process health and real database/job readiness", async () => {
    const app = createFoundationApp();

    const health = await request(app)
      .get("/healthz")
      .set("X-Request-Id", "health-check-1");
    expect(health.status).toBe(200);
    expect(health.headers["x-request-id"]).toBe("health-check-1");
    const healthBody = HealthResponse.parse(health.body);
    expect(healthBody).toEqual({ status: "ok", requestId: "health-check-1" });

    const ready = await request(app)
      .get("/readyz")
      .set("X-Request-Id", "ready-check-1");
    expect(ready.status).toBe(200);
    const readyBody = ReadinessResponse.parse(ready.body);
    expect(readyBody).toEqual({
      status: "ok",
      checks: { database: "ok", jobs: "ok" },
      requestId: "ready-check-1",
    });
  });

  it("reports unavailable jobs without hiding a working database", async () => {
    const response = await request(createFoundationApp({ jobsReady: false })).get("/readyz");
    const readinessBody = ReadinessResponse.parse(response.body);

    expect(response.status).toBe(503);
    expect(readinessBody.status).toBe("not_ready");
    expect(readinessBody.checks).toEqual({ database: "ok", jobs: "unavailable" });
    expect(readinessBody.requestId).toEqual(expect.any(String));
  });

  it("returns a localized error envelope with the trusted request ID", async () => {
    const response = await request(createFoundationApp())
      .get("/v1/missing-foundation-route")
      .set("Accept-Language", "hi-IN, en;q=0.8")
      .set("X-Request-Id", "error-check-1");
    const errorBody = ErrorResponse.parse(response.body);

    expect(response.status).toBe(404);
    expect(response.headers["x-request-id"]).toBe("error-check-1");
    expect(errorBody).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "मांगा गया संसाधन नहीं मिला।",
      },
      requestId: "error-check-1",
    });
  });

  it("rejects non-JSON bodies on versioned writes while accepting JSON", async () => {
    const app = createFoundationApp({
      mountRoutes: (mountedApp) => {
        mountedApp.post("/v1/foundation-json", (_request, response) => {
          response.status(201).json({ accepted: true });
        });
      },
    });

    const rejected = await request(app)
      .post("/v1/foundation-json")
      .set("Content-Type", "text/plain")
      .send("not-json");
    const rejectedBody = ErrorResponse.parse(rejected.body);
    expect(rejected.status).toBe(415);
    expect(rejectedBody.error).toEqual({
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "The request body must use JSON.",
    });
    expect(rejectedBody.requestId).toEqual(expect.any(String));

    const accepted = await request(app)
      .post("/v1/foundation-json")
      .set("Content-Type", "application/json")
      .send({ value: "json" });
    const acceptedBody = AcceptedResponse.parse(accepted.body);
    expect(accepted.status).toBe(201);
    expect(acceptedBody).toEqual({ accepted: true });
  });

  it("clears stale cookies and renews only sessions extended by the resolver", async () => {
    const principal = {
      kind: "MEMBER" as const,
      sessionId: "session-1",
      phoneE164: "+919999900000",
      memberId: "member-1",
      familyPublicId: "AGR-123456-00001",
      roles: [],
      isHead: false,
    };
    const app = createFoundationApp({
      principalResolver: {
        resolve: (request) => {
          const cookie = request.get("Cookie");
          if (cookie?.includes("sid=stale") === true) {
            return Promise.reject(new AppError("SESSION_EXPIRED", 401));
          }
          return Promise.resolve({
            principal,
            sessionRefreshed: cookie?.includes("sid=valid") === true,
          });
        },
        sessionTtlSeconds: () => 3600,
      },
      mountRoutes: (mountedApp) => {
        mountedApp.get("/v1/foundation-session", (request, response) => {
          response.json({ principal: request.principal });
        });
        mountedApp.post("/v1/auth/session", (_request, response) => {
          response.setHeader(
            "Set-Cookie",
            "sid=recovered; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax",
          );
          response.status(201).json({ signedIn: true });
        });
      },
    });

    const valid = await request(app)
      .get("/v1/foundation-session")
      .set("Cookie", "sid=valid");
    expect(valid.status).toBe(200);
    expect(valid.headers["set-cookie"]).toEqual([
      "sid=valid; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);

    const recent = await request(app)
      .get("/v1/foundation-session")
      .set("Cookie", "sid=recent");
    expect(recent.status).toBe(200);
    expect(recent.headers["set-cookie"]).toBeUndefined();

    const stale = await request(app)
      .get("/v1/foundation-session")
      .set("Cookie", "sid=stale");
    expect(stale.status).toBe(200);
    const staleBody = z.object({ principal: z.null() }).parse(stale.body);
    expect(staleBody.principal).toBeNull();
    expect(stale.headers["set-cookie"]).toEqual([
      "sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);

    const login = await request(app)
      .post("/v1/auth/session")
      .set("Cookie", "sid=stale")
      .set("Origin", WEB_ORIGIN)
      .send({});
    expect(login.status).toBe(201);
    expect(login.body).toEqual({ signedIn: true });
    expect(login.headers["set-cookie"]).toEqual([
      "sid=recovered; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  it("maps malformed and oversized JSON bodies to 400 and 413", async () => {
    const app = createFoundationApp({
      mountRoutes: (mountedApp) => {
        mountedApp.post("/v1/foundation-parser", (_request, response) => {
          response.status(201).json({ accepted: true });
        });
      },
    });

    const malformed = await request(app)
      .post("/v1/foundation-parser")
      .set("Content-Type", "application/json")
      .send("{");
    expect(malformed.status).toBe(400);
    const malformedBody = ErrorResponse.parse(malformed.body);
    expect(malformedBody.error.code).toBe("VALIDATION_FAILED");

    const oversized = await request(app)
      .post("/v1/foundation-parser")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) }));
    expect(oversized.status).toBe(413);
    const oversizedBody = ErrorResponse.parse(oversized.body);
    expect(oversizedBody.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("requires an exact allowed origin for cookie-authenticated writes", async () => {
    const app = createFoundationApp({
      mountRoutes: (mountedApp) => {
        mountedApp.post("/v1/foundation-csrf", (_request, response) => {
          response.json({ accepted: true });
        });
      },
    });

    const allowed = await request(app)
      .post("/v1/foundation-csrf")
      .set("Cookie", "sid=session-1")
      .set("Origin", WEB_ORIGIN);
    const allowedBody = AcceptedResponse.parse(allowed.body);
    expect(allowed.status).toBe(200);
    expect(allowedBody).toEqual({ accepted: true });

    const missingOrigin = await request(app)
      .post("/v1/foundation-csrf")
      .set("Cookie", "sid=session-1");
    const missingOriginBody = ErrorResponse.parse(missingOrigin.body);
    expect(missingOrigin.status).toBe(403);
    expect(missingOriginBody.error.code).toBe("FORBIDDEN");

    const nearMatchOrigin = await request(app)
      .post("/v1/foundation-csrf")
      .set("Cookie", "sid=session-1")
      .set("Origin", `${WEB_ORIGIN}.evil`);
    const nearMatchOriginBody = ErrorResponse.parse(nearMatchOrigin.body);
    expect(nearMatchOrigin.status).toBe(403);
    expect(nearMatchOriginBody.error.code).toBe("FORBIDDEN");
  });

  it("aggregates malformed configuration instead of failing on the first issue", () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      APP_ENV: "invalid",
      PORT: "3000",
      DATABASE_URL: "",
      DATABASE_MIGRATION_URL: "postgresql://postgres:password@localhost:5432/agrawal_test",
      WEB_ORIGINS: WEB_ORIGIN,
      FIREBASE_PROJECT_ID: "project",
      FIREBASE_SERVICE_ACCOUNT_JSON: "{}",
      RAZORPAY_KEY_ID: "key-id",
      RAZORPAY_KEY_SECRET: "key-secret",
      RAZORPAY_WEBHOOK_SECRET: "webhook-secret",
      REGISTRATION_PAYMENT_PAISE: "100",
      BUSINESS_LISTING_FEE_PAISE: "4900",
      PAYMENT_IDENTITY_HMAC_KEY: Buffer.from("too-short").toString("base64"),
      S3_BUCKET: "bucket",
      AWS_REGION: "ap-south-1",
      MEDIA_URL_TTL_SECONDS: "3600",
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_APPLICATION_CREDENTIALS_JSON: "{}",
      IMAGE_SCREENING_ENABLED: "true",
      EVENT_PASS_SIGNING_KEYS: "[]",
      BLOCKED_WORDS: "[]",
      WORKERS_ENABLED: "true",
    };

    delete environment.SIGHTENGINE_API_USER;
    delete environment.SIGHTENGINE_API_SECRET;

    let thrown: unknown;
    try {
      loadConfig(environment);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    if (!(thrown instanceof ConfigError)) {
      throw new Error("loadConfig did not throw ConfigError");
    }

    expect(thrown.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variable: "APP_ENV" }),
        expect.objectContaining({ variable: "DATABASE_URL" }),
        expect.objectContaining({ variable: "PAYMENT_IDENTITY_HMAC_KEY" }),
        expect.objectContaining({ variable: "SIGHTENGINE_API_USER" }),
        expect.objectContaining({ variable: "SIGHTENGINE_API_SECRET" }),
      ]),
    );
    expect(thrown.issues.length).toBeGreaterThan(1);
  });
});
