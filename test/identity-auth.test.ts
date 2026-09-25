import { createHash } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import type { PhoneTokenVerifier, VerifiedPhoneToken } from "../src/adapters/ports.js";
import { FixedClock } from "../src/clock.js";
import type { RateLimitStore } from "../src/http/rate-limit.js";
import type {
  IdentityDatabase,
  IdentityTxClient,
  SessionDelegate,
  SessionRow,
} from "../src/modules/identity/db.js";
import { createIdentityRoutes } from "../src/modules/identity/routes.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { getTestDatabase } from "./setup.js";

const WEB_ORIGIN = "https://register.example.test";
const REGISTRATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CURRENT_TIME = new Date("2026-09-25T12:00:00.000Z");

function createIdentityFixture(options: {
  readonly sessions?: readonly SessionRow[];
} = {}) {
  const clock = new FixedClock(CURRENT_TIME);
  const sessions = [...(options.sessions ?? [])];
  const rateCounts = new Map<string, number>();
  const rateLimitStore: RateLimitStore = {
    increment: (name, key) => {
      const bucket = `${name}:${key}`;
      const count = (rateCounts.get(bucket) ?? 0) + 1;
      rateCounts.set(bucket, count);
      return Promise.resolve(count);
    },
    purge: () => Promise.resolve(0),
  };
  const session: SessionDelegate = {
    findUnique: ({ where }) => Promise.resolve(sessions.find((candidate) =>
      "id" in where
        ? candidate.id === where.id
        : candidate.tokenHash === where.tokenHash,
    ) ?? null),
    create: () => Promise.resolve<SessionRow>({
      id: "created-session",
      tokenHash: "",
      client: "MOBILE",
      phoneE164: "+919000000000",
      memberId: null,
      registrationId: REGISTRATION_ID,
      createdAt: clock.now(),
      lastSeenAt: clock.now(),
      expiresAt: clock.now(),
      revokedAt: null,
      revokedReason: null,
      userAgent: null,
    }),
    update: ({ where, data }) => {
      const index = sessions.findIndex((candidate) => candidate.id === where.id);
      const current = sessions[index];
      if (current === undefined) {
        return Promise.reject(new Error(`Missing session ${where.id}`));
      }
      const lastSeenAt = data.lastSeenAt;
      const expiresAt = data.expiresAt;
      if (!(lastSeenAt instanceof Date) || !(expiresAt instanceof Date)) {
        return Promise.reject(new Error("Unexpected session update in identity test"));
      }
      const updated = { ...current, lastSeenAt, expiresAt };
      sessions[index] = updated;
      return Promise.resolve(updated);
    },
    updateMany: () => Promise.resolve({ count: 0 }),
  };
  const memberRole: IdentityTxClient["memberRole"] = {
    findMany: () => Promise.resolve([]),
    create: () => Promise.reject(new Error("Unexpected member-role creation in identity test")),
    deleteMany: () => Promise.resolve({ count: 0 }),
    findUnique: () => Promise.resolve(null),
  };
  const transactionClient: IdentityTxClient = { session, memberRole };
  const database: IdentityDatabase = {
    ...transactionClient,
    rateLimitBucket: {
      upsert: () => Promise.resolve({ count: 1 }),
      deleteMany: () => Promise.resolve({ count: 0 }),
    },
    $transaction<T>(callback: (tx: IdentityTxClient) => Promise<T>): Promise<T> {
      return callback(transactionClient);
    },
  };
  const verifier: PhoneTokenVerifier = {
    verifyIdToken: (idToken) => Promise.resolve<VerifiedPhoneToken>({
      uid: idToken,
      phoneE164: `+91${(9000000000 + Number(idToken)).toString()}`,
      authTime: clock.now(),
      signInProvider: "phone",
    }),
  };
  const service = new IdentityService({
    db: database,
    verifier,
    registration: {
      openForPhone: () => Promise.resolve({ registrationId: REGISTRATION_ID }),
    },
    register: {
      memberPrincipalForPhone: () => Promise.resolve(null),
      isActiveMember: () => Promise.resolve(false),
      isHeadOf: () => Promise.resolve(false),
      familyOf: () => Promise.resolve(null),
    },
    clock,
    config: { sessionTtlWebDays: 30, sessionTtlMobileDays: 90 },
    rateLimitStore,
    processingRecord: { write: () => Promise.resolve() },
  });
  return { service };
}

function createIdentityApp(service: IdentityService) {
  return createApp({
    config: { webOrigins: [WEB_ORIGIN] },
    database: getTestDatabase(),
    jobs: { isReady: () => Promise.resolve(true) },
    principalResolver: service,
    mountRoutes: (app) => app.use(createIdentityRoutes({ service })),
  });
}

describe("identity HTTP authentication", () => {
  it("uses the Express-resolved client IP for session-create limits", async () => {
    const { service } = createIdentityFixture();
    const app = createIdentityApp(service);
    const trustedProxyClientIp = "203.0.113.42";

    for (let index = 0; index < 30; index += 1) {
      const response = await request(app)
        .post("/v1/auth/session")
        .set("Origin", WEB_ORIGIN)
        .set("X-Forwarded-For", `198.51.100.${(index + 1).toString()}, ${trustedProxyClientIp}`)
        .send({ firebaseIdToken: String(index), client: "MOBILE" });
      expect(response.status).toBe(201);
    }

    const limited = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .set("X-Forwarded-For", `198.51.100.31, ${trustedProxyClientIp}`)
      .send({ firebaseIdToken: "30", client: "MOBILE" });
    const errorBody = z
      .object({ error: z.object({ code: z.string() }) })
      .parse(limited.body);

    expect(limited.status).toBe(429);
    expect(errorBody.error.code).toBe("RATE_LIMITED");
  });

  it("renews a cookie only when the identity service extends the session", async () => {
    const token = "test-session-token";
    const row: SessionRow = {
      id: "session-1",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      client: "WEB",
      phoneE164: "+919000000000",
      memberId: null,
      registrationId: REGISTRATION_ID,
      createdAt: new Date(CURRENT_TIME.getTime() - 2 * 60 * 60 * 1000),
      lastSeenAt: new Date(CURRENT_TIME.getTime() - 2 * 60 * 60 * 1000),
      expiresAt: new Date(CURRENT_TIME.getTime() + 24 * 60 * 60 * 1000),
      revokedAt: null,
      revokedReason: null,
      userAgent: null,
    };
    const { service } = createIdentityFixture({ sessions: [row] });
    const app = createIdentityApp(service);

    const refreshed = await request(app)
      .get("/v1/auth/me")
      .set("Cookie", `sid=${token}`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers["set-cookie"]).toEqual([
      `sid=${token}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);

    const recent = await request(app)
      .get("/v1/auth/me")
      .set("Cookie", `sid=${token}`);
    expect(recent.status).toBe(200);
    expect(recent.headers["set-cookie"]).toBeUndefined();
  });
});
