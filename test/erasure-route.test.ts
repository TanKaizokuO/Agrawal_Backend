import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "../src/clock.js";
import { AppError, errorMiddleware } from "../src/http/errors.js";
import type { JobRuntime } from "../src/jobs.js";
import { createRegisterRoutes, RegisterService } from "../src/modules/register/index.js";
import type { Database } from "../src/db.js";
import { getTestDatabase } from "./setup.js";

const FAMILY_ID = "019b3d5c-5f0f-7a00-8000-0000000000e1";
const FAMILY_PUBLIC_ID = "AGR-125001-00011";
const MEMBER_ID = "019b3d5c-5f0f-7a00-8000-0000000000e2";
const MEMBER_PHONE = "+919876543210";

async function createMemberFixture(database: Database): Promise<void> {
  await database.family.create({
    data: {
      id: FAMILY_ID,
      publicId: FAMILY_PUBLIC_ID,
      gotra: "GARG",
      pincodeSnapshot: "125001",
      headMemberId: MEMBER_ID,
      status: "ACTIVE",
    },
  });

  await database.member.create({
    data: {
      id: MEMBER_ID,
      phoneE164: MEMBER_PHONE,
      status: "ACTIVE",
      nameEn: "Test Member",
      nameHi: null,
      nameEnSearchKey: "test member",
      fatherNameEn: "Father",
      fatherNameHi: null,
      fatherNameEnSearchKey: "father",
      gender: "MALE",
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      bloodGroup: "O_POS",
      addressLine1: "123 Street",
      pincode: "125001",
      city: "Hisar",
      cityKey: "hisar",
      state: "HARYANA",
      nativePlaceKind: "UNKNOWN",
      consentDirectory: true,
      consentBloodGroup: true,
      consentPhoto: true,
      paymentDisclosureAckAt: new Date("1990-01-01T00:00:00.000Z"),
    },
  });

  await database.familyLink.create({
    data: {
      familyId: FAMILY_ID,
      memberId: MEMBER_ID,
      kind: "BIRTH",
    },
  });
}

function createRegisterService(database: Database): RegisterService {
  const noOp = (): Promise<void> => Promise.resolve();
  const jobs: JobRuntime = {
    enabled: false,
    start: noOp,
    stop: noOp,
    isReady: () => Promise.resolve(true),
    send: () => Promise.resolve(null),
    registerWorker: noOp,
  };

  return new RegisterService({
    db: database,
    clock: new FixedClock(new Date("2026-09-24T10:00:00.000Z")),
    config: {
      retentionDaysPayments: 365,
      retentionDaysConsentAndLogs: 365,
      mediaUrlTtlSeconds: 3600,
      erasureSelfServiceEnabled: true,
    },
    pincodeDirectory: { lookup: () => Promise.resolve(null) },
    objectStore: {
      put: noOp,
      presignGet: () => Promise.resolve("https://example.test/image"),
      delete: noOp,
    },
    jobs,
    payments: { moveToRestricted: noOp, releaseHeadAnchor: noOp },
    suspensionResolver: { resolveActiveSuspension: () => Promise.resolve(null) },
    processingRecord: { write: () => Promise.resolve() },
  });
}

function createErasureApp(options: {
  service: RegisterService;
  erasureSelfServiceEnabled: boolean;
  identityService?: {
    verifyAndConsumeOtp: (phoneE164: string, otp: string) => Promise<void>;
  };
  memberId?: string;
  phoneE164?: string;
}): Express {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.principal = {
      kind: "MEMBER",
      sessionId: "erasure-test-session",
      memberId: options.memberId ?? MEMBER_ID,
      phoneE164: options.phoneE164 ?? MEMBER_PHONE,
      familyPublicId: FAMILY_PUBLIC_ID,
      roles: [],
      isHead: true,
    };
    next();
  });
  app.use(
    createRegisterRoutes({
      service: options.service,
      erasureSelfServiceEnabled: options.erasureSelfServiceEnabled,
      identityService: options.identityService,
    }),
  );
  app.use(errorMiddleware());
  return app;
}

describe("Erasure route re-authentication and dispatch", () => {
  it("executes erasure when self-service is enabled and valid OTP is provided", async () => {
    const database = getTestDatabase();
    await createMemberFixture(database);
    const service = createRegisterService(database);

    const verifyAndConsumeOtp = vi.fn().mockResolvedValue(undefined);
    const app = createErasureApp({
      service,
      erasureSelfServiceEnabled: true,
      identityService: { verifyAndConsumeOtp },
    });

    const response = await request(app)
      .post("/v1/me/erasure")
      .send({ otp: "123456" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ERASED" });
    expect(verifyAndConsumeOtp).toHaveBeenCalledTimes(1);
    expect(verifyAndConsumeOtp).toHaveBeenCalledWith(MEMBER_PHONE, "123456");

    const member = await database.member.findUnique({ where: { id: MEMBER_ID } });
    expect(member).toBeNull();
  });

  it("returns 401 OTP_INVALID when self-service is enabled and OTP is invalid", async () => {
    const database = getTestDatabase();
    await createMemberFixture(database);
    const service = createRegisterService(database);

    const verifyAndConsumeOtp = vi.fn().mockRejectedValue(new AppError("OTP_INVALID", 401));
    const app = createErasureApp({
      service,
      erasureSelfServiceEnabled: true,
      identityService: { verifyAndConsumeOtp },
    });

    const response = await request(app)
      .post("/v1/me/erasure")
      .send({ otp: "000000" });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "OTP_INVALID" } });
    expect(verifyAndConsumeOtp).toHaveBeenCalledTimes(1);
    expect(verifyAndConsumeOtp).toHaveBeenCalledWith(MEMBER_PHONE, "000000");

    const member = await database.member.findUnique({ where: { id: MEMBER_ID } });
    expect(member).not.toBeNull();
  });

  it("returns 400 VALIDATION_FAILED when self-service is enabled and otp is missing", async () => {
    const database = getTestDatabase();
    await createMemberFixture(database);
    const service = createRegisterService(database);

    const verifyAndConsumeOtp = vi.fn().mockResolvedValue(undefined);
    const app = createErasureApp({
      service,
      erasureSelfServiceEnabled: true,
      identityService: { verifyAndConsumeOtp },
    });

    const response = await request(app)
      .post("/v1/me/erasure")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(verifyAndConsumeOtp).not.toHaveBeenCalled();

    const member = await database.member.findUnique({ where: { id: MEMBER_ID } });
    expect(member).not.toBeNull();
  });

  it("returns 400 VALIDATION_FAILED when self-service is enabled and otp pattern is invalid", async () => {
    const database = getTestDatabase();
    await createMemberFixture(database);
    const service = createRegisterService(database);

    const verifyAndConsumeOtp = vi.fn().mockResolvedValue(undefined);
    const app = createErasureApp({
      service,
      erasureSelfServiceEnabled: true,
      identityService: { verifyAndConsumeOtp },
    });

    const response = await request(app)
      .post("/v1/me/erasure")
      .send({ otp: "123" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(verifyAndConsumeOtp).not.toHaveBeenCalled();
  });

  it("returns 202 queued when self-service is disabled without otp", async () => {
    const database = getTestDatabase();
    await createMemberFixture(database);
    const service = createRegisterService(database);

    const verifyAndConsumeOtp = vi.fn().mockResolvedValue(undefined);
    const app = createErasureApp({
      service,
      erasureSelfServiceEnabled: false,
      identityService: { verifyAndConsumeOtp },
    });

    const response = await request(app)
      .post("/v1/me/erasure")
      .send({});

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "PENDING" });
    expect(verifyAndConsumeOtp).not.toHaveBeenCalled();

    const pending = await database.erasureRequest.findFirst({
      where: { memberId: MEMBER_ID, status: "PENDING" },
    });
    expect(pending).not.toBeNull();
  });

  it("returns 202 queued regardless of otp when self-service is disabled", async () => {
    const database = getTestDatabase();
    await createMemberFixture(database);
    const service = createRegisterService(database);

    const verifyAndConsumeOtp = vi.fn().mockResolvedValue(undefined);
    const app = createErasureApp({
      service,
      erasureSelfServiceEnabled: false,
      identityService: { verifyAndConsumeOtp },
    });

    const response = await request(app)
      .post("/v1/me/erasure")
      .send({ otp: "123456" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "PENDING" });
    expect(verifyAndConsumeOtp).not.toHaveBeenCalled();

    const pending = await database.erasureRequest.findFirst({
      where: { memberId: MEMBER_ID, status: "PENDING" },
    });
    expect(pending).not.toBeNull();
  });
});
