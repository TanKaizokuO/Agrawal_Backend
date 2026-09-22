import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock.js";
import {
  MediaService,
  type ImagePurpose,
  type MediaObjectStore,
} from "../src/modules/media/service.js";
import { RegisterService, type RegisterDeps } from "../src/modules/register/index.js";
import { getTestDatabase } from "./setup.js";

const MEMBER_ID = "019b3d5c-5f0f-7a00-8000-0000000000a1";
const OTHER_MEMBER_ID = "019b3d5c-5f0f-7a00-8000-0000000000a2";
const FAMILY_ID = "019b3d5c-5f0f-7a00-8000-0000000000f1";

class FakeObjectStore implements MediaObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  put(input: { readonly key: string; readonly body: Uint8Array }): Promise<void> {
    this.objects.set(input.key, new Uint8Array(input.body));
    return Promise.resolve();
  }

  presignGet(key: string): Promise<string> {
    return Promise.resolve(`https://media.test/${encodeURIComponent(key)}`);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array> {
    const body = this.objects.get(key);
    if (body === undefined) return Promise.reject(new Error(`missing object ${key}`));
    return Promise.resolve(body);
  }
}

async function imageBytes(): Promise<Uint8Array> {
  return sharp({
    create: { width: 24, height: 18, channels: 3, background: { r: 140, g: 120, b: 90 } },
  }).jpeg().toBuffer();
}

interface PhotoWrites {
  readonly member: unknown[];
  readonly family: unknown[];
}

function createRegister(media: MediaService, writes: PhotoWrites): RegisterService {
  const db = {
    member: {
      update: (args: unknown) => {
        writes.member.push(args);
        return Promise.resolve({});
      },
    },
    family: {
      update: (args: unknown) => {
        writes.family.push(args);
        return Promise.resolve({});
      },
    },
    familyLink: {
      findUnique: () => Promise.resolve({
        family: { id: FAMILY_ID, publicId: "AGR-123456-00001", gotra: "GARG", headMemberId: MEMBER_ID },
      }),
    },
  };
  return new RegisterService({
    // Unchecked cast for test database mock
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
    suspensionResolver: { resolveActiveSuspension: () => Promise.resolve(null) },
    media,
  });
}

describe("Register photo ownership", () => {
  const database = getTestDatabase();
  let media: MediaService;
  let writes: PhotoWrites;
  let register: RegisterService;

  async function upload(memberId: string, purpose: ImagePurpose): Promise<string> {
    const uploaded = await media.upload({
      purpose,
      body: await imageBytes(),
      contentType: "image/jpeg",
      owner: { memberId },
    });
    return uploaded.imageId;
  }

  beforeEach(async () => {
    await database.image.deleteMany();
    media = new MediaService({
      db: database,
      clock: new FixedClock(new Date("2026-09-22T04:00:00.000Z")),
      config: { imageScreeningEnabled: false, mediaUrlTtlSeconds: 600 },
      objectStore: new FakeObjectStore(),
      jobs: { send: () => Promise.resolve("job-1") },
    });
    writes = { member: [], family: [] };
    register = createRegister(media, writes);
  });

  it("refuses another member's image as the member photo", async () => {
    const theirs = await upload(OTHER_MEMBER_ID, "MEMBER_PHOTO");

    await expect(register.setMemberPhoto(MEMBER_ID, theirs)).rejects.toMatchObject({ code: "IMAGE_NOT_OWNED" });
    expect(writes.member).toHaveLength(0);
  });

  it("refuses the member's own image uploaded for a different purpose", async () => {
    const listingPhoto = await upload(MEMBER_ID, "BUSINESS_PHOTO");

    await expect(register.setMemberPhoto(MEMBER_ID, listingPhoto)).rejects.toMatchObject({ code: "IMAGE_NOT_OWNED" });
    expect(writes.member).toHaveLength(0);
  });

  it("accepts the member's own photo and clearing the photo", async () => {
    const mine = await upload(MEMBER_ID, "MEMBER_PHOTO");

    await register.setMemberPhoto(MEMBER_ID, mine);
    await register.setMemberPhoto(MEMBER_ID, null);

    expect(writes.member).toHaveLength(2);
  });

  it("refuses another member's image as the family photo", async () => {
    const theirs = await upload(OTHER_MEMBER_ID, "FAMILY_PHOTO");

    await expect(register.setFamilyPhoto(MEMBER_ID, theirs)).rejects.toMatchObject({ code: "IMAGE_NOT_OWNED" });
    expect(writes.family).toHaveLength(0);
  });

  it("accepts the head's own family photo", async () => {
    const mine = await upload(MEMBER_ID, "FAMILY_PHOTO");

    await register.setFamilyPhoto(MEMBER_ID, mine);

    expect(writes.family).toHaveLength(1);
  });
});
