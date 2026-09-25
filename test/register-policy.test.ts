import { describe, expect, it } from "vitest";
import type { MeResponse } from "../src/modules/register/schemas.js";
import {
  RegisterService,
  type RegisterDeps,
} from "../src/modules/register/index.js";

const SUBJECT_MEMBER_ID = "member-1";
const FAMILY_VIEWER_ID = "family-member";
const SAMAJ_VIEWER_ID = "outside-member";

function createProjectionService(): RegisterService {
  const targetMember = {
    id: SUBJECT_MEMBER_ID,
    link: {
      familyId: "family-1",
      family: {
        publicId: "AGR-123456-00001",
        gotra: "GARG",
        headMemberId: SUBJECT_MEMBER_ID,
      },
    },
    status: "ACTIVE",
    phoneE164: "+919876543210",
    nameEn: "Amit",
    nameHi: "अमित",
    fatherNameEn: "Ram",
    fatherNameHi: "राम",
    gender: "MALE",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    bloodGroup: "A_POS",
    addressLine1: "123 Main",
    addressLine2: null,
    city: "Hisar",
    state: "HARYANA",
    pincode: "125001",
    district: "Hisar",
    nativePlaceKind: "UNKNOWN",
    nativePlaceId: null,
    nativePlaceText: null,
    kuldevi: null,
    kuldevta: null,
    nomineeMemberId: null,
    photoImageId: null,
    consentDirectory: false,
    consentBloodGroup: true,
    consentPhoto: true,
  };
  const familyByMember: Record<string, string> = {
    [SUBJECT_MEMBER_ID]: "family-1",
    [FAMILY_VIEWER_ID]: "family-1",
    [SAMAJ_VIEWER_ID]: "family-2",
  };
  const db = {
    member: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.includes(SUBJECT_MEMBER_ID) ? [targetMember] : []),
    },
    familyLink: {
      findUnique: ({ where }: { where: { memberId: string } }) => {
        const familyId = familyByMember[where.memberId];
        return Promise.resolve(familyId === undefined ? null : { familyId });
      },
    },
  };
  const noOp = (): Promise<void> => Promise.resolve();

  return new RegisterService({
    db: db as unknown as RegisterDeps["db"],
    clock: { now: () => new Date("2026-09-19T10:00:00.000Z"), todayIst: () => "2026-09-19" },
    config: {
      retentionDaysPayments: 365,
      retentionDaysConsentAndLogs: 365,
      mediaUrlTtlSeconds: 3600,
      erasureSelfServiceEnabled: true,
    },
    pincodeDirectory: { lookup: () => Promise.resolve(null) },
    objectStore: {
      put: noOp,
      presignGet: () => Promise.resolve("https://example.com/img"),
      delete: noOp,
    },
    jobs: {
      send: () => Promise.resolve(null),
      registerWorker: noOp,
      start: noOp,
      stop: noOp,
      isReady: () => Promise.resolve(true),
      enabled: false,
    },
    payments: { moveToRestricted: noOp, releaseHeadAnchor: noOp },
    suspensionResolver: { resolveActiveSuspension: () => Promise.resolve(null) },
  });
}

async function projectSubject(service: RegisterService, viewerMemberId: string) {
  const projections = await service.project(viewerMemberId, [SUBJECT_MEMBER_ID]);
  const projection = projections.get(SUBJECT_MEMBER_ID);
  if (projection === undefined) throw new Error("Expected the subject Member to be projected");
  return projection;
}

describe("Register visibility policy", () => {
  it("invariant 16: phone is visible to SELF and linked FAMILY, but not the wider Samaj", async () => {
    const service = createProjectionService();
    const samaj = await projectSubject(service, SAMAJ_VIEWER_ID);
    const family = await projectSubject(service, FAMILY_VIEWER_ID);
    const self = await projectSubject(service, SUBJECT_MEMBER_ID);

    expect(samaj).toMatchObject({
      memberId: SUBJECT_MEMBER_ID,
      name: { en: "Amit", hi: "अमित" },
    });
    expect(samaj).not.toHaveProperty("phoneE164");
    expect(family.phoneE164).toBe("+919876543210");
    expect(self.phoneE164).toBe("+919876543210");
  });

  it("invariant 20: blood group is visible only in the Member's own projection", async () => {
    const service = createProjectionService();
    const samaj = await projectSubject(service, SAMAJ_VIEWER_ID);
    const family = await projectSubject(service, FAMILY_VIEWER_ID);
    const self = await projectSubject(service, SUBJECT_MEMBER_ID);

    expect(samaj).not.toHaveProperty("bloodGroup");
    expect(family).not.toHaveProperty("bloodGroup");
    expect(self.bloodGroup).toBe("A_POS");
  });

  it("invariant 22: directory consent does not filter projections and Member-only fields stay private", async () => {
    const service = createProjectionService();
    const samaj = await projectSubject(service, SAMAJ_VIEWER_ID);
    const family = await projectSubject(service, FAMILY_VIEWER_ID);
    const self = await projectSubject(service, SUBJECT_MEMBER_ID);

    expect(samaj).toMatchObject({
      memberId: SUBJECT_MEMBER_ID,
      familyPublicId: "AGR-123456-00001",
      isHead: true,
      name: { en: "Amit", hi: "अमित" },
      gotra: "GARG",
      city: "Hisar",
      state: "HARYANA",
      photoUrl: null,
    });
    expect(samaj).not.toHaveProperty("phoneE164");
    expect(samaj).not.toHaveProperty("fatherOrHusbandName");

    expect(family).toMatchObject({
      phoneE164: "+919876543210",
      fatherOrHusbandName: { en: "Ram", hi: "राम" },
    });
    for (const projection of [samaj, family]) {
      expect(projection).not.toHaveProperty("gender");
      expect(projection).not.toHaveProperty("dateOfBirth");
      expect(projection).not.toHaveProperty("address");
      expect(projection).not.toHaveProperty("nativePlace");
      expect(projection).not.toHaveProperty("kuldevi");
      expect(projection).not.toHaveProperty("kuldevta");
      expect(projection).not.toHaveProperty("nominee");
      expect(projection).not.toHaveProperty("consents");
    }
    expect(self).toMatchObject({
      gender: "MALE",
      dateOfBirth: "1990-01-01",
      address: {
        line1: "123 Main",
        line2: null,
        pincode: "125001",
        district: "Hisar",
      },
      nativePlace: { kind: "UNKNOWN", id: null, text: null },
      kuldevi: null,
      kuldevta: null,
      nominee: { memberId: null },
      consents: {
        directory: false,
        bloodGroupMatching: true,
        photoVisible: true,
      },
    });
  });

  it("fails closed when suspensionResolver dependency is absent", () => {
    const partialDeps = {
      // Unchecked cast for test mock
      db: {} as unknown as RegisterDeps["db"],
      clock: { now: () => new Date(), todayIst: () => "2026-09-19" },
      config: {
        retentionDaysPayments: 365,
        retentionDaysConsentAndLogs: 365,
        mediaUrlTtlSeconds: 3600,
        erasureSelfServiceEnabled: true,
      },
      pincodeDirectory: { lookup: () => Promise.resolve(null) },
      objectStore: {
        put: () => Promise.resolve(),
        presignGet: () => Promise.resolve("https://example.com/img"),
        delete: () => Promise.resolve(),
      },
      jobs: {
        send: () => Promise.resolve(null),
        registerWorker: () => Promise.resolve(),
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        isReady: () => Promise.resolve(true),
        enabled: false,
      },
      payments: { moveToRestricted: () => Promise.resolve(), releaseHeadAnchor: () => Promise.resolve() },
    };

    expect(() => new RegisterService(partialDeps as unknown as RegisterDeps)).toThrow(/requires suspensionResolver/);
  });

  it("returns active suspension on getMe via injected suspension resolver", async () => {
    const mockDb = {
      member: {
        findUnique: () => Promise.resolve({
          id: "member-1",
          link: {
            familyId: "family-1",
            family: { publicId: "AGR-123456-00001", gotra: "GARG", headMemberId: "member-1", _count: { links: 1 } },
          },
          status: "ACTIVE",
          phoneE164: "+919876543210",
          nameEn: "Amit",
          nameHi: "अमित",
          fatherOrHusbandNameEn: "Ram",
          fatherOrHusbandNameHi: "राम",
          gender: "MALE",
          dateOfBirth: new Date("1990-01-01"),
          bloodGroup: "A_POS",
          addressLine1: "123 Main",
          addressLine2: null,
          city: "Hisar",
          state: "HARYANA",
          pincode: "125001",
          district: "Hisar",
          nativePlaceKind: "UNKNOWN",
          nativePlaceId: null,
          nativePlaceText: null,
          kuldevi: null,
          kuldevta: null,
          photoImageId: null,
          consentBloodGroup: true,
          consentPhoto: true,
          uiLanguage: "en",
          nomineePromptPending: false,
        }),
      },
      officerMessage: { findMany: () => Promise.resolve([]) },
      erasureRequest: { findFirst: () => Promise.resolve(null) },
    };

    const service = new RegisterService({
      // Unchecked cast for test database mock
      db: mockDb as unknown as RegisterDeps["db"],
      clock: { now: () => new Date("2026-09-19T10:00:00.000Z"), todayIst: () => "2026-09-19" },
      config: {
        retentionDaysPayments: 365,
        retentionDaysConsentAndLogs: 365,
        mediaUrlTtlSeconds: 3600,
        erasureSelfServiceEnabled: true,
      },
      pincodeDirectory: { lookup: () => Promise.resolve(null) },
      objectStore: {
        put: () => Promise.resolve(),
        presignGet: () => Promise.resolve("https://example.com/img"),
        delete: () => Promise.resolve(),
      },
      jobs: {
        send: () => Promise.resolve(null),
        registerWorker: () => Promise.resolve(),
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        isReady: () => Promise.resolve(true),
        enabled: false,
      },
      payments: { moveToRestricted: () => Promise.resolve(), releaseHeadAnchor: () => Promise.resolve() },
      suspensionResolver: {
        resolveActiveSuspension: () => Promise.resolve({
          endsAt: "2026-10-01T00:00:00.000Z",
          reason: "REPORTS",
          noticeId: "notice-1",
        }),
      },
    });

    const me: MeResponse = await service.getMe("member-1", ["MEMBER"]);
    expect(me.suspension).toEqual({
      endsAt: "2026-10-01T00:00:00.000Z",
      reason: "REPORTS",
      noticeId: "notice-1",
    });
    // openapi.json names the caller's own projection `member`; the Flutter
    // client fails to deserialize /v1/me when it is sent under any other key.
    expect(Object.keys(me)).toContain("member");
    expect(Object.keys(me)).not.toContain("self");
  });
});
