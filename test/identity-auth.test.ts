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
  readonly member?: {
    readonly phoneE164: string;
    readonly memberId: string;
    readonly familyPublicId: string;
    readonly status: "ACTIVE" | "ARCHIVED";
  };
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
    create: ({ data }) => {
      const created = data as unknown as SessionRow;
      sessions.push(created);
      return Promise.resolve(created);
    },
    update: ({ where, data }) => {
      const index = sessions.findIndex((candidate) => candidate.id === where.id);
      const current = sessions[index];
      if (current === undefined) {
        return Promise.reject(new Error(`Missing session ${where.id}`));
      }
      const updated = { ...current, ...data };
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
      memberPrincipalForPhone: (phoneE164) => {
        const member = options.member;
        return Promise.resolve(member !== undefined && member.phoneE164 === phoneE164
          ? { memberId: member.memberId, status: member.status }
          : null);
      },
      isActiveMember: () => Promise.resolve(false),
      isHeadOf: () => Promise.resolve(false),
      familyOf: (memberId) => {
        const member = options.member;
        if (member === undefined || member.memberId !== memberId || member.status !== "ACTIVE") {
          return Promise.resolve(null);
        }
        return Promise.resolve({ publicId: member.familyPublicId });
      },
    },
    clock,
    config: { sessionTtlWebDays: 30, sessionTtlMobileDays: 90 },
    rateLimitStore,
    processingRecord: { write: () => Promise.resolve() },
  });
  return { service, sessions };
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

  it("creates a persisted Applicant bearer with fixed mobile OTP and revokes it on logout", async () => {
    const { service, sessions } = createIdentityFixture();
    const app = createIdentityApp(service);
    const phoneE164 = "+919000000000";

    const login = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({ phoneE164, otp: "123456", client: "MOBILE" });
    expect(login.status).toBe(201);
    const loginBody = z.object({
      principal: z.object({
        kind: z.literal("APPLICANT"),
        phoneE164: z.string(),
        registrationId: z.string(),
      }),
      token: z.string().min(1),
    }).parse(login.body);
    expect(loginBody.principal).toEqual({
      kind: "APPLICANT",
      phoneE164,
      registrationId: REGISTRATION_ID,
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.phoneE164).toBe(phoneE164);
    expect(sessions[0]?.registrationId).toBe(REGISTRATION_ID);
    expect(sessions[0]?.tokenHash).not.toBe(loginBody.token);

    const current = await request(app)
      .get("/v1/auth/me")
      .set("Authorization", `Bearer ${loginBody.token}`);
    expect(current.status).toBe(200);
    expect(current.body).toEqual({ principal: loginBody.principal });

    const logout = await request(app)
      .delete("/v1/auth/session")
      .set("Authorization", `Bearer ${loginBody.token}`);
    expect(logout.status).toBe(204);
    expect(sessions[0]?.revokedReason).toBe("LOGOUT");
    expect(sessions[0]?.revokedAt).toEqual(CURRENT_TIME);

    const revoked = await request(app)
      .get("/v1/auth/me")
      .set("Authorization", `Bearer ${loginBody.token}`);
    expect(revoked.status).toBe(401);
  });

  it("rejects incorrect OTP without creating a session", async () => {
    const { service, sessions } = createIdentityFixture();
    const app = createIdentityApp(service);

    const response = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({ phoneE164: "+919000000000", otp: "654321", client: "MOBILE" });
    const errorBody = z
      .object({ error: z.object({ code: z.string() }) })
      .parse(response.body);

    expect(response.status).toBe(401);
    expect(errorBody.error.code).toBe("FIXED_OTP_INVALID");
    expect(sessions).toHaveLength(0);
  });

  it("validates phone and OTP boundaries and rejects WEB or ambiguous OTP requests", async () => {
    const { service, sessions } = createIdentityFixture();
    const app = createIdentityApp(service);

    const invalidPhone = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({ phoneE164: "+915123456789", otp: "123456", client: "MOBILE" });
    expect(invalidPhone.status).toBe(400);

    const invalidOtp = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({ phoneE164: "+919000000000", otp: "12345", client: "MOBILE" });
    expect(invalidOtp.status).toBe(400);

    const webOtp = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({ phoneE164: "+919000000000", otp: "123456", client: "WEB" });
    expect(webOtp.status).toBe(400);
    expect(z.object({ error: z.object({ code: z.string() }) }).parse(webOtp.body).error.code)
      .toBe("VALIDATION_FAILED");

    const ambiguous = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        firebaseIdToken: "1",
        phoneE164: "+919000000000",
        otp: "123456",
        client: "MOBILE",
      });
    expect(ambiguous.status).toBe(400);
    expect(z.object({ error: z.object({ code: z.string() }) }).parse(ambiguous.body).error.code)
      .toBe("VALIDATION_FAILED");
    expect(sessions).toHaveLength(0);
  });

  it("creates a Member principal for an active member and denies an archived phone", async () => {
    const phoneE164 = "+919000000000";
    const active = createIdentityFixture({
      member: {
        phoneE164,
        memberId: "member-1",
        familyPublicId: "AGR-123456-00001",
        status: "ACTIVE",
      },
    });
    const activeApp = createIdentityApp(active.service);
    const login = await request(activeApp)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({ phoneE164, otp: "123456", client: "MOBILE" });
    expect(login.status).toBe(201);
    const memberLogin = z.object({
      principal: z.object({
        kind: z.literal("MEMBER"),
        phoneE164: z.string(),
        memberId: z.string(),
        familyPublicId: z.string(),
      }),
      token: z.string().min(1),
    }).parse(login.body);
    expect(memberLogin.principal).toMatchObject({
      kind: "MEMBER",
      phoneE164,
      memberId: "member-1",
      familyPublicId: "AGR-123456-00001",
    });
    expect(active.sessions[0]?.memberId).toBe("member-1");
    expect(active.sessions[0]?.registrationId).toBeNull();

    const archived = createIdentityFixture({
      member: {
        phoneE164,
        memberId: "archived-member",
        familyPublicId: "AGR-123456-00001",
        status: "ARCHIVED",
      },
    });
    const archivedApp = createIdentityApp(archived.service);
    const denied = await request(archivedApp)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({ phoneE164, otp: "123456", client: "MOBILE" });
    expect(denied.status).toBe(403);
    expect(z.object({ error: z.object({ code: z.string() }) }).parse(denied.body).error.code)
      .toBe("PHONE_BELONGS_TO_ARCHIVED_MEMBER");
    expect(archived.sessions).toHaveLength(0);
  });

  it("applies the existing per-phone limit to failed fixed OTP attempts", async () => {
    const { service, sessions } = createIdentityFixture();
    const app = createIdentityApp(service);
    const requestOtp = () => request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({ phoneE164: "+919000000000", otp: "654321", client: "MOBILE" });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await requestOtp()).status).toBe(401);
    }
    const limited = await requestOtp();

    expect(limited.status).toBe(429);
    expect(z.object({ error: z.object({ code: z.string() }) }).parse(limited.body).error.code)
      .toBe("RATE_LIMITED");
    expect(sessions).toHaveLength(0);
  });
});
