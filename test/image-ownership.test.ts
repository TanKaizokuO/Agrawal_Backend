import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock.js";
import {
  MediaService,
  type ImagePurpose,
  type MediaObjectStore,
} from "../src/modules/media/service.js";
import { RegisterService, type RegisterDeps } from "../src/modules/register/index.js";
import type { Database } from "../src/db.js";
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

function createRegister(
  media: MediaService,
  writes: PhotoWrites,
  database?: RegisterDeps["db"],
): RegisterService {
  const testDb = {
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
    db: database ?? (testDb as unknown as RegisterDeps["db"]),
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

async function createPhotoOwner(database: Database): Promise<void> {
  await database.family.create({
    data: {
      id: FAMILY_ID,
      publicId: "AGR-123456-00001",
      gotra: "GARG",
      pincodeSnapshot: "123456",
      headMemberId: MEMBER_ID,
    },
  });
  await database.member.create({
    data: {
      id: MEMBER_ID,
      phoneE164: "+919876543210",
      status: "ACTIVE",
      nameEn: "Photo Owner",
      nameHi: null,
      nameEnSearchKey: "photo owner",
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
      pincode: "123456",
      nativePlaceKind: "UNKNOWN",
      nativePlaceId: null,
      nativePlaceText: null,
      kuldevi: null,
      kuldevta: null,
      nomineeMemberId: null,
      nomineePromptPending: false,
      consentDirectory: true,
      consentBloodGroup: false,
      consentPhoto: true,
      paymentDisclosureAckAt: new Date("2026-09-19T00:00:00.000Z"),
      uiLanguage: "en",
    },
  });
  await database.familyLink.create({
    data: { memberId: MEMBER_ID, familyId: FAMILY_ID, kind: "BIRTH" },
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

  it("clears only the Register photo reference for an image removed by Media", async () => {
    await createPhotoOwner(database);
    const memberPhoto = await upload(MEMBER_ID, "MEMBER_PHOTO");
    const familyPhoto = await media.upload({
      purpose: "FAMILY_PHOTO",
      body: await imageBytes(),
      contentType: "image/jpeg",
      owner: { memberId: MEMBER_ID, familyId: FAMILY_ID },
    });
    await database.member.update({ where: { id: MEMBER_ID }, data: { photoImageId: memberPhoto } });
    await database.family.update({ where: { id: FAMILY_ID }, data: { photoImageId: familyPhoto.imageId } });

    writes = { member: [], family: [] };
    register = createRegister(media, writes, database);
    media.onImageRemoved((tx, event) => {
      if (event.purpose === "MEMBER_PHOTO" || event.purpose === "FAMILY_PHOTO") {
        return register.handleImageRemoved(tx, event);
      }
      return Promise.resolve();
    });

    await media.removeImage({ imageId: memberPhoto, officerMemberId: OTHER_MEMBER_ID, reason: "explicit image" });
    await expect(register.getMe(MEMBER_ID, [])).resolves.toMatchObject({ member: { photoUrl: null } });
    expect((await register.getFamilyForMember(MEMBER_ID)).family.photoUrl).toMatch(/^https:/u);

    await media.removeImage({ imageId: familyPhoto.imageId, officerMemberId: OTHER_MEMBER_ID, reason: "explicit image" });
    await expect(register.getFamilyForMember(MEMBER_ID)).resolves.toMatchObject({ family: { photoUrl: null } });
  });

});
