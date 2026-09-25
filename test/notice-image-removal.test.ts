import { describe, expect, it } from "vitest";
import { InMemoryNoticesDatabase, NoticesService } from "../src/modules/notices/index.js";

const REMOVED_IMAGE_ID = "019b3d5c-5f0f-7a00-8000-000000000101";
const OTHER_IMAGE_ID = "019b3d5c-5f0f-7a00-8000-000000000102";

function createNoticesService(db: InMemoryNoticesDatabase): NoticesService {
  return new NoticesService({
    db,
    clock: { now: () => new Date("2026-09-25T10:00:00.000Z"), todayIst: () => "2026-09-25" },
    config: {
      postingCapPerDay: 3,
      reportsThreshold: 5,
      suspensionDurationDays: 7,
      archivalEscalationDays: 7,
      businessListingDurationDays: 180,
      blockedWords: [],
      phoneRegexInText: "",
    },
    register: {
      isActiveMember: () => Promise.resolve(true),
      familyOf: () => Promise.resolve(null),
      adultMembersOfFamily: () => Promise.resolve([]),
      archiveMember: () => Promise.resolve(),
      project: () => Promise.resolve(new Map()),
      onMemberErased: () => {},
    },
    media: {
      urlFor: () => Promise.resolve(null),
      ownedBy: () => Promise.resolve(true),
    },
    business: {
      isBoardOpen: () => true,
      getListingFeePaise: () => null,
      createPaymentOrder: () => Promise.reject(new Error("unused payment order")),
      markConsumed: () => Promise.resolve(),
      refund: () => Promise.resolve(),
    },
    notifications: { send: () => Promise.resolve() },
    processingRecord: { write: () => Promise.resolve() },
  });
}

describe("Notice image removal", () => {
  it("clears only Notices that reference the removed image", async () => {
    const db = new InMemoryNoticesDatabase();
    const service = createNoticesService(db);
    const commonNotice = {
      board: "SHOK_SANDESH" as const,
      authorMemberId: "019b3d5c-5f0f-7a00-8000-000000000201",
      authorFamilyId: "019b3d5c-5f0f-7a00-8000-000000000202",
      bodyEn: "A community notice",
    };
    await db.notice.create({
      data: { id: "019b3d5c-5f0f-7a00-8000-000000000301", ...commonNotice, imageId: REMOVED_IMAGE_ID },
    });
    await db.notice.create({
      data: { id: "019b3d5c-5f0f-7a00-8000-000000000302", ...commonNotice, imageId: OTHER_IMAGE_ID },
    });

    await db.$transaction((tx) => service.handleImageRemoved(tx, REMOVED_IMAGE_ID));

    await expect(service.getNotice("019b3d5c-5f0f-7a00-8000-000000000401", "019b3d5c-5f0f-7a00-8000-000000000301"))
      .resolves.toMatchObject({ notice: { imageId: null, imageUrl: null } });
    await expect(service.getNotice("019b3d5c-5f0f-7a00-8000-000000000401", "019b3d5c-5f0f-7a00-8000-000000000302"))
      .resolves.toMatchObject({ notice: { imageId: OTHER_IMAGE_ID } });
  });
});
