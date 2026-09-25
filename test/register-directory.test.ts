import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FixedClock } from "../src/clock.js";
import { errorMiddleware } from "../src/http/errors.js";
import type { JobRuntime } from "../src/jobs.js";
import { createRegisterRoutes, RegisterService } from "../src/modules/register/index.js";
import type { Database } from "../src/db.js";
import { getTestDatabase } from "./setup.js";

const MemberConsentResponse = z.object({
  member: z.object({
    consents: z.object({
      directory: z.boolean(),
      bloodGroupMatching: z.boolean(),
      photoVisible: z.boolean(),
    }),
  }),
});

const HIDDEN_FAMILY_ID = "019b3d5c-5f0f-7a00-8000-0000000000f1";
const HIDDEN_FAMILY_PUBLIC_ID = "AGR-125001-00001";
const HIDDEN_HEAD_ID = "019b3d5c-5f0f-7a00-8000-0000000000a1";
const FAMILY_MEMBER_ID = "019b3d5c-5f0f-7a00-8000-0000000000a2";
const OUTSIDE_FAMILY_ID = "019b3d5c-5f0f-7a00-8000-0000000000f2";
const OUTSIDE_FAMILY_PUBLIC_ID = "AGR-125001-00002";
const OUTSIDE_MEMBER_ID = "019b3d5c-5f0f-7a00-8000-0000000000b1";

interface TestMember {
  readonly id: string;
  readonly phoneE164: string;
  readonly nameEn: string;
  readonly consentDirectory: boolean;
  readonly consentBloodGroup: boolean;
  readonly consentPhoto: boolean;
}

async function createFamily(
  database: Database,
  input: {
    readonly id: string;
    readonly publicId: string;
    readonly headMemberId: string;
    readonly members: readonly TestMember[];
  },
): Promise<void> {
  await database.family.create({
    data: {
      id: input.id,
      publicId: input.publicId,
      gotra: "GARG",
      pincodeSnapshot: "125001",
      headMemberId: input.headMemberId,
      status: "ACTIVE",
    },
  });

  for (const member of input.members) {
    await database.member.create({
      data: {
        id: member.id,
        phoneE164: member.phoneE164,
        status: "ACTIVE",
        nameEn: member.nameEn,
        nameHi: null,
        nameEnSearchKey: member.nameEn.toLowerCase(),
        fatherNameEn: "Ram",
        fatherNameHi: null,
        fatherNameEnSearchKey: "ram",
        gender: "MALE",
        dateOfBirth: new Date("1980-01-01T00:00:00.000Z"),
        bloodGroup: "O_POS",
        addressLine1: "12 Market Road",
        addressLine2: null,
        city: "Hisar",
        cityKey: "hisar",
        district: "Hisar",
        state: "HARYANA",
        pincode: "125001",
        nativePlaceKind: "UNKNOWN",
        nativePlaceId: null,
        nativePlaceText: null,
        kuldevi: null,
        kuldevta: null,
        photoImageId: null,
        nomineeMemberId: null,
        nomineePromptPending: false,
        consentDirectory: member.consentDirectory,
        consentBloodGroup: member.consentBloodGroup,
        consentPhoto: member.consentPhoto,
        paymentDisclosureAckAt: new Date("2026-09-24T00:00:00.000Z"),
        uiLanguage: "en",
      },
    });
    await database.familyLink.create({
      data: { memberId: member.id, familyId: input.id, kind: "BIRTH" },
    });
  }
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
  });
}

function createRegisterApp(
  service: RegisterService,
  identity: {
    readonly memberId: string;
    readonly phoneE164: string;
    readonly familyPublicId: string;
  } = {
    memberId: OUTSIDE_MEMBER_ID,
    phoneE164: "+919876543211",
    familyPublicId: OUTSIDE_FAMILY_PUBLIC_ID,
  },
): Express {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.principal = {
      kind: "MEMBER",
      sessionId: "directory-test-session",
      ...identity,
      roles: [],
      isHead: true,
    };
    next();
  });
  app.use(createRegisterRoutes({
    service,
    erasureSelfServiceEnabled: false,
    reauthenticate: () => Promise.resolve(false),
  }));
  app.use(errorMiddleware());
  return app;
}

async function createDirectoryFixtures(database: Database): Promise<void> {
  await createFamily(database, {
    id: HIDDEN_FAMILY_ID,
    publicId: HIDDEN_FAMILY_PUBLIC_ID,
    headMemberId: HIDDEN_HEAD_ID,
    members: [
      {
        id: HIDDEN_HEAD_ID,
        phoneE164: "+919876543201",
        nameEn: "Hidden Member",
        consentDirectory: false,
        consentBloodGroup: true,
        consentPhoto: true,
      },
      {
        id: FAMILY_MEMBER_ID,
        phoneE164: "+919876543202",
        nameEn: "Family Member",
        consentDirectory: true,
        consentBloodGroup: true,
        consentPhoto: true,
      },
    ],
  });
  await createFamily(database, {
    id: OUTSIDE_FAMILY_ID,
    publicId: OUTSIDE_FAMILY_PUBLIC_ID,
    headMemberId: OUTSIDE_MEMBER_ID,
    members: [
      {
        id: OUTSIDE_MEMBER_ID,
        phoneE164: "+919876543211",
        nameEn: "Outside Member",
        consentDirectory: true,
        consentBloodGroup: true,
        consentPhoto: true,
      },
    ],
  });
}

describe("Register directory consent boundaries", () => {
  const database = getTestDatabase();

  it("hides opted-out Members from directory search and lookups, but not Family or module projections", async () => {
    await createDirectoryFixtures(database);
    const service = createRegisterService(database);

    const outsideSearch = await service.searchDirectory(OUTSIDE_MEMBER_ID, {
      q: "Hidden Member",
      limit: 20,
    });
    expect(outsideSearch.items.map((member) => member.memberId)).toEqual([]);

    const familySearch = await service.searchDirectory(FAMILY_MEMBER_ID, {
      q: "Hidden Member",
      limit: 20,
    });
    expect(familySearch.items.map((member) => member.memberId)).toEqual([HIDDEN_HEAD_ID]);

    const selfSearch = await service.searchDirectory(HIDDEN_HEAD_ID, {
      q: "Hidden Member",
      limit: 20,
    });
    expect(selfSearch.items.map((member) => member.memberId)).toEqual([HIDDEN_HEAD_ID]);

    await expect(service.getDirectoryMember(OUTSIDE_MEMBER_ID, HIDDEN_HEAD_ID))
      .rejects.toMatchObject({ code: "MEMBER_NOT_FOUND", httpStatus: 404 });
    expect((await service.getDirectoryMember(FAMILY_MEMBER_ID, HIDDEN_HEAD_ID)).memberId)
      .toBe(HIDDEN_HEAD_ID);
    expect((await service.getDirectoryMember(HIDDEN_HEAD_ID, HIDDEN_HEAD_ID)).memberId)
      .toBe(HIDDEN_HEAD_ID);

    const outsideFamily = await service.getDirectoryFamily(OUTSIDE_MEMBER_ID, HIDDEN_FAMILY_PUBLIC_ID);
    expect(outsideFamily.members.map((member) => member.memberId)).toEqual([FAMILY_MEMBER_ID]);
    expect(outsideFamily.family).toMatchObject({ memberCount: 1, headMemberId: null });

    const familyView = await service.getDirectoryFamily(FAMILY_MEMBER_ID, HIDDEN_FAMILY_PUBLIC_ID);
    expect(familyView.members.map((member) => member.memberId).sort())
      .toEqual([FAMILY_MEMBER_ID, HIDDEN_HEAD_ID].sort());
    expect(familyView.family).toMatchObject({ memberCount: 2, headMemberId: HIDDEN_HEAD_ID });

    const moduleProjection = await service.project(OUTSIDE_MEMBER_ID, [HIDDEN_HEAD_ID]);
    expect(moduleProjection.get(HIDDEN_HEAD_ID)?.name?.en).toBe("Hidden Member");
  });

  it("accepts partial consent updates and rejects directory withdrawal or an empty body over HTTP", async () => {
    await createDirectoryFixtures(database);
    const app = createRegisterApp(createRegisterService(database));

    const partialUpdate = await request(app)
      .put("/v1/me/consents")
      .send({ photoVisible: false });
    expect(partialUpdate.status).toBe(204);

    const currentMember = await request(app).get("/v1/me");
    expect(currentMember.status).toBe(200);
    expect(MemberConsentResponse.parse(currentMember.body).member.consents).toEqual({
      directory: true,
      bloodGroupMatching: true,
      photoVisible: false,
    });

    const directoryWithdrawal = await request(app)
      .put("/v1/me/consents")
      .send({ bloodGroupMatching: false, photoVisible: true, directory: false });
    expect(directoryWithdrawal.status).toBe(400);

    const emptyUpdate = await request(app)
      .put("/v1/me/consents")
      .send({});
    expect(emptyUpdate.status).toBe(400);
  });

  it("allows an opted-out Member to reaffirm directory consent through HTTP", async () => {
    await createDirectoryFixtures(database);
    const app = createRegisterApp(createRegisterService(database), {
      memberId: HIDDEN_HEAD_ID,
      phoneE164: "+919876543201",
      familyPublicId: HIDDEN_FAMILY_PUBLIC_ID,
    });

    const response = await request(app)
      .put("/v1/me/consents")
      .send({ directory: true });
    expect(response.status).toBe(204);

    const currentMember = await request(app).get("/v1/me");
    expect(MemberConsentResponse.parse(currentMember.body).member.consents.directory).toBe(true);
  });
});
