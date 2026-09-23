import { describe, expect, it } from "vitest";
import {
  FAMILY_FIELDS,
  PROJECTION_ALLOWLIST,
  SAMAJ_FIELDS,
  SELF_FIELDS,
  type MeResponse,
} from "../src/modules/register/schemas.js";
import {
  RegisterService,
  type RegisterDeps,
} from "../src/modules/register/index.js";
describe("Register visibility policy", () => {
  it("invariant 16: phone is limited to SELF and linked FAMILY projections", () => {
    expect(SAMAJ_FIELDS).not.toContain("phoneE164");
    expect(FAMILY_FIELDS).toContain("phoneE164");
    expect(SELF_FIELDS).toContain("phoneE164");
  });

  it("invariant 20: blood group is SELF-only", () => {
    expect(SAMAJ_FIELDS).not.toContain("bloodGroup");
    expect(FAMILY_FIELDS).not.toContain("bloodGroup");
    expect(SELF_FIELDS).toContain("bloodGroup");
  });

  it("invariant 22: every non-self audience is closed by default", () => {
    const allRelations = Object.values(PROJECTION_ALLOWLIST).flat();
    expect(allRelations).not.toContain("nameEnSearchKey");
    expect(allRelations).not.toContain("fatherNameEnSearchKey");
    expect(allRelations).not.toContain("paymentDisclosureAckAt");
    expect(SAMAJ_FIELDS).toEqual([
      "memberId",
      "familyPublicId",
      "isHead",
      "name",
      "gotra",
      "city",
      "state",
      "photoUrl",
    ]);
    expect(FAMILY_FIELDS).toEqual([...SAMAJ_FIELDS, "phoneE164", "fatherOrHusbandName"]);
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
