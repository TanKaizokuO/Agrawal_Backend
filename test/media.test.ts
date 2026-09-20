import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../src/http/errors.js";
import { isRecord } from "../src/adapters/guards.js";
import { FixedClock } from "../src/clock.js";
import {
  JOB_NAMES,
  MediaService,
  type ImageScreenResult,
  type MediaImageScreener,
  type MediaObjectStore,
} from "../src/modules/media/service.js";
import { getTestDatabase } from "./setup.js";
import type { Database } from "../src/db.js";

const REGISTRATION_ID = "019b3d5c-5f0f-7a00-8000-000000000001";
const OTHER_REGISTRATION_ID = "019b3d5c-5f0f-7a00-8000-000000000002";
const MEMBER_ID = "019b3d5c-5f0f-7a00-8000-000000000003";
const OTHER_MEMBER_ID = "019b3d5c-5f0f-7a00-8000-000000000004";

class FakeObjectStore implements MediaObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  put(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<void> {
    this.objects.set(input.key, new Uint8Array(input.body));
    return Promise.resolve();
  }

  presignGet(key: string, ttlSeconds: number): Promise<string> {
    if (!this.objects.has(key)) return Promise.reject(new Error(`missing object ${key}`));
    return Promise.resolve(`https://media.test/${encodeURIComponent(key)}?ttl=${String(ttlSeconds)}`);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
  get(key: string): Promise<Uint8Array> {
    const body = this.objects.get(key);
    if (body === undefined) return Promise.reject(new Error(`missing object ${key}`));
    return Promise.resolve(new Uint8Array(body));
  }
}

class FakeScreener implements MediaImageScreener {
  calls = 0;
  constructor(private readonly result: ImageScreenResult | Error) {}

  screen(): Promise<"ACCEPTED" | "REJECTED"> {
    this.calls += 1;
    if (this.result instanceof Error) return Promise.reject(this.result);
    return Promise.resolve(this.result.status);
  }

  screenWithDetails(): Promise<ImageScreenResult> {
    this.calls += 1;
    if (this.result instanceof Error) return Promise.reject(this.result);
    return Promise.resolve(this.result);
  }
}

class FakeJobs {
  readonly sent: Array<{ readonly name: string; readonly payload: unknown }> = [];

  send(name: string, payload: unknown): Promise<string> {
    this.sent.push({ name, payload });
    return Promise.resolve(`job-${String(this.sent.length)}`);
  }
}

async function imageBytes(): Promise<Uint8Array> {
  return sharp({
    create: {
      width: 24,
      height: 18,
      channels: 3,
      background: { r: 140, g: 120, b: 90 },
    },
  })
    .jpeg()
    .toBuffer();
}

function createService(
  database: Database,
  objectStore: FakeObjectStore,
  jobs: FakeJobs,
  options: {
    readonly screeningEnabled: boolean;
    readonly screener?: MediaImageScreener;
  },
): MediaService {
  return new MediaService({
    db: database,
    clock: new FixedClock(new Date("2026-09-22T04:00:00.000Z")),
    config: {
      imageScreeningEnabled: options.screeningEnabled,
      mediaUrlTtlSeconds: 600,
    },
    objectStore,
    jobs,
    imageScreener: options.screener,
  });
}

describe("Media visibility, ownership and cleanup", () => {
  const database = getTestDatabase();

  beforeEach(async () => {
    await database.image.deleteMany();
  });

  it("keeps an unscreened image uploader-only before and after ownership transfer", async () => {
    const objectStore = new FakeObjectStore();
    const jobs = new FakeJobs();
    const service = createService(database, objectStore, jobs, { screeningEnabled: false });
    const uploaded = await service.upload({
      purpose: "MEMBER_PHOTO",
      body: await imageBytes(),
      contentType: "image/jpeg",
      owner: { registrationId: REGISTRATION_ID },
    });

    await expect(service.urlFor(uploaded.imageId, { registrationId: REGISTRATION_ID })).resolves.toMatch(/^https:/u);
    await expect(service.urlFor(uploaded.imageId, { memberId: OTHER_MEMBER_ID })).resolves.toBeNull();
    await expect(service.urlFor(uploaded.imageId, { registrationId: OTHER_REGISTRATION_ID })).resolves.toBeNull();

    await database.$transaction(async (tx) => {
      await service.reassign(tx, [uploaded.imageId], { ownerMemberId: MEMBER_ID });
    });
    await expect(service.ownedByRegistration(uploaded.imageId, REGISTRATION_ID, "MEMBER_PHOTO")).resolves.toBe(false);
    await expect(service.ownedBy(uploaded.imageId, { memberId: MEMBER_ID }, "MEMBER_PHOTO")).resolves.toBe(true);
    await expect(service.urlFor(uploaded.imageId, { memberId: MEMBER_ID })).resolves.toMatch(/^https:/u);
    await expect(service.urlFor(uploaded.imageId, { memberId: OTHER_MEMBER_ID })).resolves.toBeNull();
    await expect(service.isVisibleToOthers(uploaded.imageId)).resolves.toBe(false);
  });

  it("stores rejected screening results for review but never serves them to another member", async () => {
    const objectStore = new FakeObjectStore();
    const jobs = new FakeJobs();
    const service = createService(database, objectStore, jobs, {
      screeningEnabled: true,
      screener: new FakeScreener({
        status: "REJECTED",
        reason: "EXPLICIT",
        score: { sexual_activity: 0.1, sexual_display: 0.1, erotica: 0.9 },
      }),
    });

    let imageId = "";
    try {
      await service.upload({
        purpose: "MEMBER_PHOTO",
        body: await imageBytes(),
        contentType: "image/jpeg",
        owner: { memberId: MEMBER_ID },
      });
      throw new Error("expected screening refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) throw error;
      expect(error.code).toBe("IMAGE_REFUSED");
      if (isRecord(error.details)) {
        const candidate = error.details.imageId;
        if (typeof candidate === "string") imageId = candidate;
      }
    }
    expect(imageId).toMatch(/^[0-9a-f-]{36}$/u);

    const image = await database.image.findUnique({ where: { id: imageId } });
    expect(image?.status).toBe("REJECTED");
    await expect(service.urlFor(imageId, { memberId: OTHER_MEMBER_ID })).resolves.toBeNull();
    await expect(service.urlFor(imageId, { memberId: MEMBER_ID })).resolves.toMatch(/^https:/u);
  });

  it("screens backlog entries once and leaves uncertain screening pending for retry", async () => {
    const objectStore = new FakeObjectStore();
    const jobs = new FakeJobs();
    const uploadService = createService(database, objectStore, jobs, { screeningEnabled: false });
    const uploaded = await uploadService.upload({
      purpose: "MEMBER_PHOTO",
      body: await imageBytes(),
      contentType: "image/jpeg",
      owner: { memberId: MEMBER_ID },
    });

    const screener = new FakeScreener({
      status: "ACCEPTED",
      score: { sexual_activity: 0.1, sexual_display: 0.1, erotica: 0.6 },
    });
    const screeningService = createService(database, objectStore, jobs, {
      screeningEnabled: true,
      screener,
    });

    await expect(screeningService.screenBacklog()).resolves.toBe(1);
    await expect(screeningService.screenBacklog()).resolves.toBe(0);
    expect(screener.calls).toBe(1);
    expect((await database.image.findUnique({ where: { id: uploaded.imageId } }))?.status).toBe("APPROVED");
    await expect(screeningService.urlFor(uploaded.imageId, { memberId: OTHER_MEMBER_ID })).resolves.toMatch(/^https:/u);
  });

  it("keeps a backlog image unscreened when screening is unavailable", async () => {
    const objectStore = new FakeObjectStore();
    const jobs = new FakeJobs();
    const uploadService = createService(database, objectStore, jobs, { screeningEnabled: false });
    const uploaded = await uploadService.upload({
      purpose: "MEMBER_PHOTO",
      body: await imageBytes(),
      contentType: "image/jpeg",
      owner: { memberId: MEMBER_ID },
    });
    const screeningService = createService(database, objectStore, jobs, {
      screeningEnabled: true,
      screener: new FakeScreener(new Error("screening unavailable")),
    });

    await expect(screeningService.screenBacklog()).resolves.toBe(0);
    expect((await database.image.findUnique({ where: { id: uploaded.imageId } }))?.status).toBe("UNSCREENED");
    await expect(screeningService.urlFor(uploaded.imageId, { memberId: OTHER_MEMBER_ID })).resolves.toBeNull();
  });

  it("rejects replacement by a different owner and erases member objects through deletion jobs", async () => {
    const objectStore = new FakeObjectStore();
    const jobs = new FakeJobs();
    const service = createService(database, objectStore, jobs, { screeningEnabled: false });
    const uploaded = await service.upload({
      purpose: "MEMBER_PHOTO",
      body: await imageBytes(),
      contentType: "image/jpeg",
      owner: { memberId: MEMBER_ID },
    });

    await expect(
      database.$transaction((tx) => service.replace(tx, uploaded.imageId, { memberId: OTHER_MEMBER_ID }, "MEMBER_PHOTO")),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_OWNED" });
    await expect(service.ownedBy(uploaded.imageId, { memberId: MEMBER_ID }, "MEMBER_PHOTO")).resolves.toBe(true);
    await database.$transaction(async (tx) => {
      await service.replace(tx, uploaded.imageId, { memberId: MEMBER_ID }, "MEMBER_PHOTO");
    });
    expect((await database.image.findUnique({ where: { id: uploaded.imageId } }))?.status).toBe("REMOVED");

    const replacement = await service.upload({
      purpose: "MEMBER_PHOTO",
      body: await imageBytes(),
      contentType: "image/jpeg",
      owner: { memberId: MEMBER_ID },
    });
    await database.$transaction(async (tx) => {
      await service.deleteAllForMember(tx, MEMBER_ID);
    });
    expect(await database.image.count({ where: { ownerMemberId: MEMBER_ID } })).toBe(0);
    const deleteJobs = jobs.sent.filter((job) => job.name === JOB_NAMES.deleteObject);
    expect(deleteJobs).toHaveLength(2);
    for (const job of deleteJobs) {
      const key = deleteJobKey(job.payload);
      expect(key).not.toBeNull();
      await service.deleteObject(key ?? "");
    }
    expect(objectStore.objects.size).toBe(0);
    await expect(service.urlFor(replacement.imageId, { memberId: MEMBER_ID })).resolves.toBeNull();
  });
});

function deleteJobKey(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const key = payload.key;
  return typeof key === "string" ? key : null;
}
