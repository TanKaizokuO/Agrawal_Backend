import { createHash } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import type { SmsSender } from "../src/adapters/ports.js";
import { FixedClock } from "../src/clock.js";
import { AppError } from "../src/http/errors.js";
import type { RateLimitStore } from "../src/http/rate-limit.js";
import type {
  IdentityDatabase,
  IdentityTxClient,
  OtpChallengeDelegate,
  OtpChallengeRow,
  SessionDelegate,
  SessionRow,
} from "../src/modules/identity/db.js";
import { createIdentityRoutes } from "../src/modules/identity/routes.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { getTestDatabase } from "./setup.js";

const WEB_ORIGIN = "https://register.example.test";
const REGISTRATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CURRENT_TIME = new Date("2026-09-25T12:00:00.000Z");
const TEST_HMAC_KEY = Buffer.alloc(32, "k").toString("base64");

function createIdentityFixture(options: {
  readonly sessions?: readonly SessionRow[];
  readonly member?: {
    readonly phoneE164: string;
    readonly memberId: string;
    readonly familyPublicId: string;
    readonly status: "ACTIVE" | "ARCHIVED";
  };
  readonly smsFailure?: boolean;
} = {}) {
  const clock = new FixedClock(CURRENT_TIME);
  const sessions = [...(options.sessions ?? [])];
  const otpChallenges: OtpChallengeRow[] = [];
  const sentOtps: Array<{ phoneE164: string; code: string }> = [];

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

  const otpChallenge: OtpChallengeDelegate = {
    findFirst: (args) => {
      const where = args?.where ?? {};
      const filtered = otpChallenges.filter((candidate) => {
        if ("phoneE164" in where && candidate.phoneE164 !== where.phoneE164) {
          return false;
        }
        if ("consumedAt" in where && where.consumedAt === null && candidate.consumedAt !== null) {
          return false;
        }
        if (where.expiresAt?.gt !== undefined) {
          const expGt = where.expiresAt.gt;
          if (candidate.expiresAt <= expGt) {
            return false;
          }
        }
        return true;
      });
      filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return Promise.resolve(filtered[0] ?? null);
    },
    create: ({ data }) => {
      const created = data as unknown as OtpChallengeRow;
      otpChallenges.push(created);
      return Promise.resolve(created);
    },
    update: ({ where, data }) => {
      const index = otpChallenges.findIndex((c) => c.id === where.id);
      const current = index === -1 ? undefined : otpChallenges[index];
      if (!current) {
        return Promise.reject(new Error(`Missing otp challenge ${where.id}`));
      }
      let attemptsVal = current.attempts;
      if ("attempts" in data) {
        const attemptsData = data.attempts;
        if (typeof attemptsData === "number") {
          attemptsVal = attemptsData;
        } else if (attemptsData && typeof attemptsData === "object" && "increment" in attemptsData && typeof attemptsData.increment === "number") {
          attemptsVal = current.attempts + attemptsData.increment;
        }
      }
      const updated: OtpChallengeRow = {
        ...current,
        ...data,
        attempts: attemptsVal,
      };
      otpChallenges[index] = updated;
      return Promise.resolve(updated);
    },
    updateMany: ({ where, data }) => {
      let count = 0;
      for (let i = 0; i < otpChallenges.length; i++) {
        const candidate = otpChallenges[i];
        if (!candidate) continue;
        if (where.id !== undefined && candidate.id !== where.id) continue;
        if (where.phoneE164 !== undefined && candidate.phoneE164 !== where.phoneE164) continue;
        if (where.consumedAt === null && candidate.consumedAt !== null) continue;
        if (where.expiresAt?.gt !== undefined && candidate.expiresAt <= where.expiresAt.gt) {
          continue;
        }
        if (where.attempts !== undefined) {
          if (typeof where.attempts === "number" && candidate.attempts !== where.attempts) {
            continue;
          }
          if (typeof where.attempts === "object") {
            if (where.attempts.lt !== undefined && candidate.attempts >= where.attempts.lt) {
              continue;
            }
            if (where.attempts.gte !== undefined && candidate.attempts < where.attempts.gte) {
              continue;
            }
          }
        }
        let attemptsVal = candidate.attempts;
        if ("attempts" in data) {
          const attemptsData = data.attempts;
          if (typeof attemptsData === "number") {
            attemptsVal = attemptsData;
          } else if (attemptsData && typeof attemptsData === "object" && "increment" in attemptsData && typeof attemptsData.increment === "number") {
            attemptsVal = candidate.attempts + attemptsData.increment;
          }
        }
        otpChallenges[i] = {
          ...candidate,
          ...data,
          attempts: attemptsVal,
        };
        count++;
      }
      return Promise.resolve({ count });
    },
    deleteMany: ({ where }) => {
      const beforeLen = otpChallenges.length;
      for (let i = otpChallenges.length - 1; i >= 0; i--) {
        const candidate = otpChallenges[i];
        if (!candidate) continue;
        if (where.id !== undefined && candidate.id === where.id) {
          otpChallenges.splice(i, 1);
        } else if (where.phoneE164 !== undefined && candidate.phoneE164 === where.phoneE164) {
          otpChallenges.splice(i, 1);
        }
      }
      return Promise.resolve({ count: beforeLen - otpChallenges.length });
    },
  };

  const transactionClient: IdentityTxClient = {
    session,
    memberRole,
    otpChallenge,
    $executeRaw: () => Promise.resolve(0),
    $queryRaw: <T = unknown>() => Promise.resolve([] as unknown as T),
  };
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


  const smsSender: SmsSender = {
    sendOtp: (phoneE164, code) => {
      if (options.smsFailure) {
        return Promise.reject(new Error("SMS gateway failure"));
      }
      sentOtps.push({ phoneE164, code });
      return Promise.resolve();
    },
  };

  const service = new IdentityService({
    db: database,
    smsSender,
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
    config: {
      sessionTtlWebDays: 30,
      sessionTtlMobileDays: 90,
      otpHmacKey: TEST_HMAC_KEY,
    },
    rateLimitStore,
    processingRecord: { write: () => Promise.resolve() },
  });

  return { service, sessions, clock, sentOtps, otpChallenges };
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
  it("happy path mobile: requests OTP, verifies SMS_OTP, and logs out", async () => {
    const { service, sessions, sentOtps } = createIdentityFixture();
    const app = createIdentityApp(service);
    const phoneE164 = "+919000000000";

    const otpRes = await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });

    expect(otpRes.status).toBe(202);
    expect(otpRes.body).toEqual({
      expiresInSeconds: 300,
      resendAfterSeconds: 30,
    });
    expect(sentOtps).toHaveLength(1);
    expect(sentOtps[0]?.phoneE164).toBe(phoneE164);
    const code = sentOtps[0]?.code ?? "";
    expect(code).toMatch(/^\d{6}$/u);

    const login = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: code },
      });

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

    const me = await request(app)
      .get("/v1/auth/me")
      .set("Authorization", `Bearer ${loginBody.token}`);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ principal: loginBody.principal });

    const logout = await request(app)
      .delete("/v1/auth/session")
      .set("Authorization", `Bearer ${loginBody.token}`);
    expect(logout.status).toBe(204);
    expect(sessions[0]?.revokedReason).toBe("LOGOUT");

    const revoked = await request(app)
      .get("/v1/auth/me")
      .set("Authorization", `Bearer ${loginBody.token}`);
    expect(revoked.status).toBe(401);
  });

  it("happy path web: requests OTP, verifies SMS_OTP with cookie, and logs out", async () => {
    const { service, sentOtps } = createIdentityFixture();
    const app = createIdentityApp(service);
    const phoneE164 = "+919000000000";

    const otpRes = await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "WEB", phoneE164 });

    expect(otpRes.status).toBe(202);
    const code = sentOtps[0]?.code ?? "";

    const login = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "WEB",
        authentication: { kind: "SMS_OTP", phoneE164, otp: code },
      });

    expect(login.status).toBe(201);
    expect(login.body).not.toHaveProperty("token");
    const rawCookies: unknown = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(rawCookies) && typeof rawCookies[0] === "string" ? rawCookies[0] : "";
    expect(cookieHeader).toContain("sid=");
    expect(cookieHeader).toContain("HttpOnly");

    const cookie = cookieHeader.split(";")[0] ?? "";
    const me = await request(app)
      .get("/v1/auth/me")
      .set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ principal: { phoneE164 } });

    const logout = await request(app)
      .delete("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .set("Cookie", cookie);
    expect(logout.status).toBe(204);
    const logoutRaw: unknown = logout.headers["set-cookie"];
    const logoutCookie = Array.isArray(logoutRaw) && typeof logoutRaw[0] === "string" ? logoutRaw[0] : "";
    expect(logoutCookie).toContain("Max-Age=0");
  });
  it("rejects wrong OTP code with 401 OTP_INVALID", async () => {
    const { service, sessions } = createIdentityFixture();
    const app = createIdentityApp(service);
    const phoneE164 = "+919000000000";

    await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });

    const login = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: "000000" },
      });

    expect(login.status).toBe(401);
    const errorBody = z.object({ error: z.object({ code: z.string() }) }).parse(login.body);
    expect(errorBody.error.code).toBe("OTP_INVALID");
    expect(sessions).toHaveLength(0);
  });

  it("rejects expired OTP code with 401 OTP_INVALID", async () => {
    const { service, clock, sentOtps } = createIdentityFixture();
    const app = createIdentityApp(service);
    const phoneE164 = "+919000000000";

    await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });

    const code = sentOtps[0]?.code ?? "";
    clock.advance(301 * 1000);

    const login = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: code },
      });

    expect(login.status).toBe(401);
    const errorBody = z.object({ error: z.object({ code: z.string() }) }).parse(login.body);
    expect(errorBody.error.code).toBe("OTP_INVALID");
  });

  it("rejects reuse of consumed code with 401 OTP_INVALID", async () => {
    const { service, sentOtps } = createIdentityFixture();
    const app = createIdentityApp(service);
    const phoneE164 = "+919000000000";

    await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });

    const code = sentOtps[0]?.code ?? "";

    const first = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: code },
      });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: code },
      });
    expect(second.status).toBe(401);
    const errorBody = z.object({ error: z.object({ code: z.string() }) }).parse(second.body);
    expect(errorBody.error.code).toBe("OTP_INVALID");
  });

  it("burns challenge after 5 wrong tries: returns 429 OTP_ATTEMPTS_EXCEEDED", async () => {
    const { service, sentOtps } = createIdentityFixture();
    const app = createIdentityApp(service);
    const phoneE164 = "+919000000000";

    await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });

    const correctCode = sentOtps[0]?.code ?? "";

    for (let tryIdx = 0; tryIdx < 5; tryIdx++) {
      const wrong = await request(app)
        .post("/v1/auth/session")
        .set("Origin", WEB_ORIGIN)
        .send({
          client: "MOBILE",
          authentication: { kind: "SMS_OTP", phoneE164, otp: "000000" },
        });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toMatchObject({ error: { code: "OTP_INVALID" } });
    }

    const burned = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: correctCode },
      });
    expect(burned.status).toBe(429);
    expect(burned.body).toMatchObject({ error: { code: "OTP_ATTEMPTS_EXCEEDED" } });

    const subsequent = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: correctCode },
      });
    expect(subsequent.status).toBe(401);
    expect(subsequent.body).toMatchObject({ error: { code: "OTP_INVALID" } });
  });

  it("invalidates older challenge when a new OTP request is made", async () => {
    const { service, clock, sentOtps } = createIdentityFixture();
    const app = createIdentityApp(service);
    const phoneE164 = "+919000000000";

    await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });
    const firstCode = sentOtps[0]?.code ?? "";

    clock.advance(31 * 1000);

    await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });
    const secondCode = sentOtps[1]?.code ?? "";

    const oldLogin = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: firstCode },
      });
    expect(oldLogin.status).toBe(401);
    expect(oldLogin.body).toMatchObject({ error: { code: "OTP_INVALID" } });

    const newLogin = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: secondCode },
      });
    expect(newLogin.status).toBe(201);
  });

  it("returns 502 OTP_DELIVERY_FAILED on send failure and leaves no usable challenge", async () => {
    const { service, otpChallenges } = createIdentityFixture({ smsFailure: true });
    const app = createIdentityApp(service);
    const phoneE164 = "+919000000000";

    const otpRes = await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });

    expect(otpRes.status).toBe(502);
    expect(otpRes.body).toMatchObject({ error: { code: "OTP_DELIVERY_FAILED" } });
    expect(otpRes.body).not.toHaveProperty("error.details");
    expect(otpChallenges).toHaveLength(0);

    const login = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: "123456" },
      });
    expect(login.status).toBe(401);
    expect(login.body).toMatchObject({ error: { code: "OTP_INVALID" } });
  });

  it("enforces resend cooldown of 30 seconds and phone hourly rate limit", async () => {
    const { service, clock } = createIdentityFixture();
    const app = createIdentityApp(service);
    const phoneE164 = "+919000000000";

    const first = await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });
    expect(first.status).toBe(202);

    const tooSoon = await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body).toMatchObject({ error: { code: "RATE_LIMITED" } });

    clock.advance(31 * 1000);
    const second = await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });
    expect(second.status).toBe(202);

    for (let i = 0; i < 3; i++) {
      clock.advance(31 * 1000);
      const res = await request(app)
        .post("/v1/auth/otp")
        .set("Origin", WEB_ORIGIN)
        .send({ client: "MOBILE", phoneE164 });
      expect(res.status).toBe(202);
    }

    clock.advance(31 * 1000);
    const rateLimited = await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });
    expect(rateLimited.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  it("validates phone and OTP boundaries and rejects legacy session requests", async () => {
    const { service, sessions } = createIdentityFixture();
    const app = createIdentityApp(service);

    const invalidPhone = await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ phoneE164: "+915123456789", client: "MOBILE" });
    expect(invalidPhone.status).toBe(400);

    const invalidOtp = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164: "+919000000000", otp: "12345" },
      });
    expect(invalidOtp.status).toBe(400);

    const legacyFixed = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({ phoneE164: "+919000000000", otp: "123456", client: "MOBILE" });
    expect(legacyFixed.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const legacyFirebase = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({ firebaseIdToken: "test", client: "MOBILE" });
    expect(legacyFirebase.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

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

    await request(activeApp)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });
    const activeCode = active.sentOtps[0]?.code ?? "";

    const login = await request(activeApp)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: activeCode },
      });
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

    await request(archivedApp)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .send({ client: "MOBILE", phoneE164 });
    const archivedCode = archived.sentOtps[0]?.code ?? "";

    const denied = await request(archivedApp)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164, otp: archivedCode },
      });
    expect(denied.body).toMatchObject({ error: { code: "PHONE_BELONGS_TO_ARCHIVED_MEMBER" } });
    expect(archived.sessions).toHaveLength(0);
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

  it("uses the Express-resolved client IP for session-create limits", async () => {
    const { service, sentOtps, clock } = createIdentityFixture();
    const app = createIdentityApp(service);
    const trustedProxyClientIp = "203.0.113.42";

    for (let index = 0; index < 30; index += 1) {
      const phoneSuffix = index < 10 ? `0${String(index)}` : String(index);
      const phone = `+9190000000${phoneSuffix}`;
      const otpRes = await request(app)
        .post("/v1/auth/otp")
        .set("Origin", WEB_ORIGIN)
        .set("X-Forwarded-For", `10.0.0.${(index + 1).toString()}`)
        .send({ client: "MOBILE", phoneE164: phone });
      expect(otpRes.status).toBe(202);

      const code = sentOtps[sentOtps.length - 1]?.code ?? "";
      const response = await request(app)
        .post("/v1/auth/session")
        .set("Origin", WEB_ORIGIN)
        .set("X-Forwarded-For", `198.51.100.${(index + 1).toString()}, ${trustedProxyClientIp}`)
        .send({
          client: "MOBILE",
          authentication: { kind: "SMS_OTP", phoneE164: phone, otp: code },
        });
      expect(response.status).toBe(201);
    }

    const limitedPhone = "+919000000099";
    clock.advance(31 * 1000);
    const limitedOtpRes = await request(app)
      .post("/v1/auth/otp")
      .set("Origin", WEB_ORIGIN)
      .set("X-Forwarded-For", "10.0.0.99")
      .send({ client: "MOBILE", phoneE164: limitedPhone });
    expect(limitedOtpRes.status).toBe(202);
    const limitedCode = sentOtps[sentOtps.length - 1]?.code ?? "";

    const limited = await request(app)
      .post("/v1/auth/session")
      .set("Origin", WEB_ORIGIN)
      .set("X-Forwarded-For", `198.51.100.31, ${trustedProxyClientIp}`)
      .send({
        client: "MOBILE",
        authentication: { kind: "SMS_OTP", phoneE164: limitedPhone, otp: limitedCode },
      });

    const errorBody = z
      .object({ error: z.object({ code: z.string() }) })
      .parse(limited.body);

    expect(limited.status).toBe(429);
    expect(errorBody.error.code).toBe("RATE_LIMITED");
  });

  it("exposes verifyAndConsumeOtp which validates format, attempt limit, and burns challenge", async () => {
    const { service, sentOtps } = createIdentityFixture();
    const phoneE164 = "+919000000000";
    await service.requestOtp({ client: "MOBILE", phoneE164, ipAddress: "127.0.0.1" });
    const code = sentOtps[0]?.code ?? "";

    await expect(service.verifyAndConsumeOtp("bad-phone", code)).rejects.toThrow();
    await expect(service.verifyAndConsumeOtp(phoneE164, "123")).rejects.toThrow();

    // Wrong guess 1..4
    for (let i = 0; i < 4; i++) {
      await expect(service.verifyAndConsumeOtp(phoneE164, "000000")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });
    }
    // 5th guess with correct code succeeds
    await expect(service.verifyAndConsumeOtp(phoneE164, code)).resolves.toBeUndefined();
    // Reuse fails
    await expect(service.verifyAndConsumeOtp(phoneE164, code)).rejects.toMatchObject({
      code: "OTP_INVALID",
    });
  });
});

describe("DB-backed OTP concurrency", () => {
  it("enforces attempt limit under 10 concurrent wrong guesses and rejects correct code afterwards", async () => {
    const realDb = getTestDatabase();
    const sentOtps: Array<{ phoneE164: string; code: string }> = [];
    const smsSender: SmsSender = {
      sendOtp: (phoneE164, code) => {
        sentOtps.push({ phoneE164, code });
        return Promise.resolve();
      },
    };
    const clock = new FixedClock(new Date("2026-10-01T10:00:00.000Z"));
    const service = new IdentityService({
      db: realDb,
      smsSender,
      registration: {
        openForPhone: () => Promise.resolve({ registrationId: "019b3d5c-5f0f-7a00-8000-000000000001" }),
      },
      register: {
        memberPrincipalForPhone: () => Promise.resolve(null),
        isActiveMember: () => Promise.resolve(false),
        isHeadOf: () => Promise.resolve(false),
        familyOf: () => Promise.resolve(null),
      },
      clock,
      config: {
        sessionTtlWebDays: 7,
        sessionTtlMobileDays: 30,
        otpHmacKey: TEST_HMAC_KEY,
      },
      processingRecord: {
        write: () => Promise.resolve(),
      },
    });

    const phoneE164 = "+919876543210";
    await service.requestOtp({ client: "MOBILE", phoneE164, ipAddress: "127.0.0.1" });
    expect(sentOtps).toHaveLength(1);
    const correctCode = sentOtps[0]?.code ?? "";

    // Fire 10 concurrent wrong guesses
    const wrongGuesses = Array.from({ length: 10 }, () =>
      service.verifyAndConsumeOtp(phoneE164, "000000").catch((err: unknown) => err)
    );
    const results = await Promise.all(wrongGuesses);

    // Verify all 10 were rejected with either OTP_INVALID (401) or OTP_ATTEMPTS_EXCEEDED (429)
    for (const res of results) {
      expect(res).toBeInstanceOf(AppError);
      expect(["OTP_INVALID", "OTP_ATTEMPTS_EXCEEDED"]).toContain((res as AppError).code);
    }

    // In DB, attempts must never exceed 5
    const challenge = await realDb.otpChallenge.findFirst({
      where: { phoneE164 },
      orderBy: { createdAt: "desc" },
    });
    expect(challenge).not.toBeNull();
    if (!challenge) throw new Error("Expected challenge to exist");
    expect(challenge.attempts).toBeLessThanOrEqual(5);
    expect(challenge.attempts).toBe(5);
    expect(challenge.consumedAt).not.toBeNull();

    // Correct code must now be rejected
    try {
      await service.verifyAndConsumeOtp(phoneE164, correctCode);
      expect.fail("Expected verifyAndConsumeOtp to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(["OTP_INVALID", "OTP_ATTEMPTS_EXCEEDED"]).toContain((err as AppError).code);
    }
  });

  it("handles two concurrent requestOtp calls yielding exactly one live challenge and one SMS send", async () => {
    const realDb = getTestDatabase();
    const sentOtps: Array<{ phoneE164: string; code: string }> = [];
    const smsSender: SmsSender = {
      sendOtp: (phoneE164, code) => {
        sentOtps.push({ phoneE164, code });
        return Promise.resolve();
      },
    };
    const clock = new FixedClock(new Date("2026-10-01T10:00:00.000Z"));
    const service = new IdentityService({
      db: realDb,
      smsSender,
      registration: {
        openForPhone: () => Promise.resolve({ registrationId: "019b3d5c-5f0f-7a00-8000-000000000001" }),
      },
      register: {
        memberPrincipalForPhone: () => Promise.resolve(null),
        isActiveMember: () => Promise.resolve(false),
        isHeadOf: () => Promise.resolve(false),
        familyOf: () => Promise.resolve(null),
      },
      clock,
      config: {
        sessionTtlWebDays: 7,
        sessionTtlMobileDays: 30,
        otpHmacKey: TEST_HMAC_KEY,
      },
      processingRecord: {
        write: () => Promise.resolve(),
      },
    });

    const phoneE164 = "+919876543211";

    const [first, second] = await Promise.allSettled([
      service.requestOtp({ client: "MOBILE", phoneE164, ipAddress: "127.0.0.1" }),
      service.requestOtp({ client: "MOBILE", phoneE164, ipAddress: "127.0.0.1" }),
    ]);

    const statuses = [first.status, second.status];
    expect(statuses).toContain("fulfilled");
    expect(statuses).toContain("rejected");

    // Exactly one SMS was sent
    expect(sentOtps).toHaveLength(1);

    // Exactly one live (unconsumed) challenge in the database
    const liveChallenges = await realDb.otpChallenge.findMany({
      where: { phoneE164, consumedAt: null },
    });
    expect(liveChallenges).toHaveLength(1);
  });
});
