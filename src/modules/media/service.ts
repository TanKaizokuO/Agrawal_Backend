import { v7 as uuidv7 } from "uuid";
import sharp from "sharp";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../http/errors.js";
import { isRecord } from "../../adapters/guards.js";
import type { Clock } from "../../clock.js";
import type { JobRuntime } from "../../jobs.js";
import type { ImageScreener, ObjectStore } from "../../adapters/ports.js";
import type { MediaDatabase, MediaTxClient } from "./db.js";

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_MAX_INPUT_DIMENSION = 10_000;
export const IMAGE_MAX_INPUT_PIXELS = 40_000_000;
export const IMAGE_QUARANTINE_RETENTION_DAYS = 30;
export const IMAGE_SCREENING_TIMEOUT_MS = 8_000;

export const MEDIA_ERROR_CODES = {
  IMAGE_TYPE_UNSUPPORTED: "IMAGE_TYPE_UNSUPPORTED",
  IMAGE_TOO_LARGE: "IMAGE_TOO_LARGE",
  IMAGE_DIMENSIONS_INVALID: "IMAGE_DIMENSIONS_INVALID",
  IMAGE_REFUSED: "IMAGE_REFUSED",
  IMAGE_NOT_FOUND: "IMAGE_NOT_FOUND",
  IMAGE_NOT_OWNED: "IMAGE_NOT_OWNED",
} as const;

export type ImagePurpose =
  | "MEMBER_PHOTO"
  | "FAMILY_PHOTO"
  | "BUSINESS_PHOTO"
  | "SHOK_SANDESH_PHOTO";

export type ImageStatus = "UNSCREENED" | "APPROVED" | "REJECTED" | "REMOVED";

export interface ImageOwner {
  readonly registrationId?: string;
  readonly memberId?: string;
  readonly familyId?: string;
}

export interface MediaViewer {
  readonly registrationId?: string;
  readonly memberId?: string;
}

export interface UploadImageInput {
  readonly purpose: ImagePurpose;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly owner: ImageOwner;
}

export interface UploadedImage {
  readonly imageId: string;
  readonly status: ImageStatus;
  readonly previewUrl: string;
}

export interface OfficerImageView {
  readonly imageId: string;
  readonly status: Exclude<ImageStatus, "REMOVED">;
  readonly purpose: ImagePurpose;
  readonly ownerMemberId: string | null;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly bytes: number;
  readonly createdAt: Date;
  readonly url: string;
}

export interface OfficerImagePage {
  readonly items: readonly OfficerImageView[];
  readonly nextCursor: string | null;
}

export interface ListOfficerImagesInput {
  readonly officerMemberId: string;
  readonly status?: Exclude<ImageStatus, "REMOVED">;
  readonly cursor?: string;
  readonly limit: number;
}

export interface RemoveImageInput {
  readonly imageId: string;
  readonly officerMemberId: string;
  readonly reason: string;
}

export interface ApproveImageInput {
  readonly imageId: string;
  readonly officerMemberId: string;
}

export type MediaProcessingAction =
  | "IMAGE_REMOVED"
  | "IMAGE_OVERRIDE_APPROVED"
  | "OFFICER_IMAGES_VIEWED";

export interface MediaProcessingEntry {
  readonly action: MediaProcessingAction;
  readonly subjectType: "IMAGE";
  readonly subjectId: string;
  readonly actor:
    | { readonly kind: "OFFICER"; readonly id: string }
    | { readonly kind: "SYSTEM"; readonly id?: string | undefined };
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MediaProcessingRecordPort {
  write(tx: MediaTxClient, entry: MediaProcessingEntry): Promise<void>;
}

export interface ImageRemovedEvent {
  readonly imageId: string;
  readonly purpose: ImagePurpose;
  readonly ownerMemberId: string | null;
  readonly familyId: string | null;
  readonly reason: string;
  readonly removedBy: string;
}

export type ImageRemovedHandler = (tx: MediaTxClient, event: ImageRemovedEvent) => Promise<void>;

export interface MediaOwnerNotificationPort {
  postOfficerMessage(
    tx: MediaTxClient,
    memberId: string,
    kind: "IMAGE_REMOVED",
    reason: string,
  ): Promise<void>;
}

export interface MediaImageScreener extends ImageScreener {
  readonly screenWithDetails?: (input: {
    readonly body: Uint8Array;
    readonly contentType: string;
  }) => Promise<ImageScreenResult>;
}

export interface ImageScreenResult {
  readonly status: "ACCEPTED" | "REJECTED";
  readonly reason?: "EXPLICIT";
  readonly score?: Readonly<Record<string, number>>;
}

export interface MediaObjectStore extends ObjectStore {
  readonly get?: (key: string) => Promise<Uint8Array>;
}

export interface MediaServiceConfig {
  readonly imageScreeningEnabled: boolean;
  readonly mediaUrlTtlSeconds: number;
  readonly maxImageBytes?: number;
  readonly quarantineRetentionDays?: number;
}
export interface MediaServiceDeps {
  readonly db: MediaDatabase;
  readonly clock: Clock;
  readonly config: MediaServiceConfig;
  readonly objectStore: MediaObjectStore;
  readonly jobs: Pick<JobRuntime, "send">;
  readonly imageScreener?: MediaImageScreener | undefined;
  readonly processingRecord?: MediaProcessingRecordPort;
  readonly ownerNotification?: MediaOwnerNotificationPort;
}

interface ImageRecord {
  readonly id: string;
  readonly purpose: ImagePurpose;
  readonly status: ImageStatus;
  readonly ownerRegistrationId: string | null;
  readonly ownerMemberId: string | null;
  readonly familyId: string | null;
  readonly s3Key: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly bytes: number;
  readonly screeningScore: unknown;
  readonly statusReason: string | null;
  readonly createdAt: Date;
  readonly screenedAt: Date | null;
  readonly removedAt: Date | null;
  readonly removedBy: string | null;
}

interface PreparedImage {
  readonly body: Uint8Array;
  readonly widthPx: number;
  readonly heightPx: number;
}

interface ScreeningDecision {
  readonly status: "UNSCREENED" | "APPROVED" | "REJECTED";
  readonly reason: string | null;
  readonly score: Readonly<Record<string, number>> | null;
  readonly screenedAt: Date | null;
}

interface Cursor {
  readonly createdAt: Date;
  readonly id: string;
}

const IMAGE_CONTENT_TYPE = "image/jpeg";
const ALLOWED_IMAGE_PURPOSES_FOR_APPLICANT = new Set<ImagePurpose>([
  "MEMBER_PHOTO",
  "FAMILY_PHOTO",
]);

export class MediaService {
  private readonly removedHandlers: ImageRemovedHandler[] = [];

  public constructor(private readonly deps: MediaServiceDeps) {}

  public onImageRemoved(handler: ImageRemovedHandler): void {
    this.removedHandlers.push(handler);
  }

  public async upload(input: UploadImageInput): Promise<UploadedImage> {
    this.validateOwnerForPurpose(input.owner, input.purpose);
    const prepared = await this.prepareImage(input.body);
    const decision = this.deps.config.imageScreeningEnabled
      ? await this.screenWithRetry(prepared.body)
      : {
          status: "UNSCREENED" as const,
          reason: null,
          score: null,
          screenedAt: null,
        };

    const imageId = uuidv7();
    const key = decision.status === "REJECTED"
      ? `quarantine/${imageId}.jpg`
      : `images/${imageId}.jpg`;
    try {
      await this.deps.objectStore.put({
        key,
        body: prepared.body,
        contentType: IMAGE_CONTENT_TYPE,
      });
      await this.deps.db.image.create({
        data: {
          id: imageId,
          purpose: input.purpose,
          status: decision.status,
          ownerRegistrationId: input.owner.registrationId ?? null,
          ownerMemberId: input.owner.memberId ?? null,
          familyId: input.owner.familyId ?? null,
          s3Key: key,
          widthPx: prepared.widthPx,
          heightPx: prepared.heightPx,
          bytes: prepared.body.byteLength,
          screeningScore: decision.score ?? Prisma.DbNull,
          statusReason: decision.reason,
          createdAt: this.deps.clock.now(),
          screenedAt: decision.screenedAt,
        },
      });
    } catch (error) {
      await this.enqueueDelete(key);
      throw error;
    }

    if (decision.status === "REJECTED") {
      throw new AppError("IMAGE_REFUSED", 422, {
        reason: decision.reason ?? "SCREENING_UNAVAILABLE",
        imageId,
        officerReview: true,
      });
    }

    return {
      imageId,
      status: decision.status,
      previewUrl: await this.deps.objectStore.presignGet(key, this.deps.config.mediaUrlTtlSeconds),
    };
  }

  public async urlFor(imageId: string, viewer: MediaViewer): Promise<string | null> {
    const image = await this.findImage(imageId);
    if (image === null || image.status === "REMOVED") return null;
    const owner = this.isViewerOwner(image, viewer);
    if (!owner && image.status !== "APPROVED") return null;
    return this.deps.objectStore.presignGet(image.s3Key, this.deps.config.mediaUrlTtlSeconds);
  }

  public async presignUrl(imageId: string, ttlSeconds = this.deps.config.mediaUrlTtlSeconds): Promise<string> {
    const image = await this.findImage(imageId);
    if (image === null || image.status === "REMOVED") throw new AppError("IMAGE_NOT_FOUND", 404);
    return this.deps.objectStore.presignGet(image.s3Key, ttlSeconds);
  }

  public async isVisibleToOthers(imageId: string): Promise<boolean> {
    const image = await this.findImage(imageId);
    return image?.status === "APPROVED";
  }

  public async ownedBy(
    imageId: string,
    owner: ImageOwner,
    purpose?: ImagePurpose,
  ): Promise<boolean> {
    const image = await this.findImage(imageId);
    if (image === null || image.status === "REMOVED") return false;
    if (purpose !== undefined && image.purpose !== purpose) return false;
    return this.ownerMatches(image, owner);
  }

  public async ownedByRegistration(
    imageId: string,
    registrationId: string,
    purpose?: ImagePurpose,
  ): Promise<boolean> {
    return this.ownedBy(imageId, { registrationId }, purpose);
  }

  public async reassign(
    tx: MediaTxClient,
    imageIds: readonly string[],
    owner: { readonly ownerMemberId: string; readonly familyId?: string },
  ): Promise<void> {
    if (imageIds.length === 0) return;
    await tx.image.updateMany({
      where: { id: { in: [...imageIds] }, status: { not: "REMOVED" } },
      data: {
        ownerRegistrationId: null,
        ownerMemberId: owner.ownerMemberId,
        familyId: owner.familyId ?? null,
      },
    });
  }
  public async replace(
    tx: MediaTxClient,
    imageId: string,
    owner: ImageOwner,
    purpose?: ImagePurpose,
  ): Promise<void> {
    const image = await tx.image.findUnique({ where: { id: imageId } });
    if (
      image === null ||
      image.status === "REMOVED" ||
      (purpose !== undefined && image.purpose !== purpose) ||
      !this.ownerMatches(image, owner)
    ) {
      throw new AppError("IMAGE_NOT_OWNED", 422);
    }
    await tx.image.update({
      where: { id: imageId },
      data: {
        status: "REMOVED",
        statusReason: "REPLACED",
        removedAt: this.deps.clock.now(),
        removedBy: null,
      },
    });
    await this.invokeRemovedHandlers(tx, {
      imageId: image.id,
      purpose: image.purpose,
      ownerMemberId: image.ownerMemberId,
      familyId: image.familyId,
      reason: "REPLACED",
      removedBy: "SYSTEM",
    });
    await this.enqueueDelete(image.s3Key);
  }


  public async deleteOwnedByRegistration(
    tx: MediaTxClient,
    registrationId: string,
  ): Promise<void> {
    const images = await tx.image.findMany({
      where: { ownerRegistrationId: registrationId },
      select: { s3Key: true },
    });
    if (images.length === 0) return;
    await tx.image.deleteMany({ where: { ownerRegistrationId: registrationId } });
    await this.enqueueDeletes(images.map((image) => image.s3Key));
  }

  public async deleteAllForMember(tx: MediaTxClient, memberId: string): Promise<void> {
    const images = await tx.image.findMany({
      where: { ownerMemberId: memberId },
      select: {
        id: true,
        purpose: true,
        ownerMemberId: true,
        familyId: true,
        s3Key: true,
        status: true,
      },
    });
    if (images.length === 0) return;
    for (const image of images) {
      if (image.status !== "REMOVED") {
        await this.invokeRemovedHandlers(tx, {
          imageId: image.id,
          purpose: image.purpose,
          ownerMemberId: image.ownerMemberId,
          familyId: image.familyId,
          reason: "ERASURE",
          removedBy: "SYSTEM",
        });
      }
    }
    await tx.image.deleteMany({ where: { ownerMemberId: memberId } });
    await this.enqueueDeletes(images.map((image) => image.s3Key));
  }

  public async gcOrphans(): Promise<number> {
    const cutoff = new Date(this.deps.clock.now().getTime() - 24 * 60 * 60 * 1000);
    const images = await this.deps.db.image.findMany({
      where: {
        createdAt: { lt: cutoff },
        ownerRegistrationId: null,
        ownerMemberId: null,
        familyId: null,
      },
      select: { id: true, s3Key: true },
    });
    if (images.length === 0) return 0;
    await this.deps.db.image.deleteMany({ where: { id: { in: images.map((image) => image.id) } } });
    await this.enqueueDeletes(images.map((image) => image.s3Key));
    return images.length;
  }

  public async screenBacklog(): Promise<number> {
    if (!this.deps.config.imageScreeningEnabled || this.deps.imageScreener === undefined) return 0;
    const objectStore = this.deps.objectStore;
    if (objectStore.get === undefined) return 0;
    const images = await this.deps.db.image.findMany({
      where: { status: "UNSCREENED" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2,
      select: {
        id: true,
        purpose: true,
        ownerMemberId: true,
        familyId: true,
        s3Key: true,
        status: true,
      },
    });
    let processed = 0;
    for (const image of images) {
      let body: Uint8Array;
      try {
        body = await objectStore.get(image.s3Key);
      } catch {
        continue;
      }
      let decision: ScreeningDecision;
      try {
        decision = await this.screenWithRetry(body);
      } catch {
        continue;
      }
      if (
        decision.status === "UNSCREENED" ||
        (decision.status === "REJECTED" && decision.reason === "SCREENING_UNAVAILABLE")
      ) continue;
      const updated = await this.deps.db.$transaction(async (tx) => {
        const result = await tx.image.updateMany({
          where: { id: image.id, status: "UNSCREENED" },
          data: {
            status: decision.status,
            statusReason: decision.reason,
            screeningScore: decision.score ?? Prisma.DbNull,
            screenedAt: decision.screenedAt,
          },
        });
        if (result.count !== 1) return result;
        if (decision.status === "REJECTED") {
          await this.invokeRemovedHandlers(tx, {
            imageId: image.id,
            purpose: image.purpose,
            ownerMemberId: image.ownerMemberId,
            familyId: image.familyId,
            reason: decision.reason ?? "SCREENING_UNAVAILABLE",
            removedBy: "SYSTEM",
          });
          if (image.ownerMemberId !== null && this.deps.ownerNotification !== undefined) {
            await this.deps.ownerNotification.postOfficerMessage(
              tx,
              image.ownerMemberId,
              "IMAGE_REMOVED",
              "The uploaded image was refused by automated screening.",
            );
          }
        }
        return result;
      });
      if (updated.count !== 1) continue;
      processed += 1;
    }
    if (images.length === 2 && processed === 2) {
      await this.deps.jobs.send(
        JOB_NAMES.screenBacklog,
        {},
        { startAfter: new Date(this.deps.clock.now().getTime() + 1_000) },
      );
    }
    return processed;
  }

  public async purgeQuarantine(): Promise<number> {
    const retentionDays = this.deps.config.quarantineRetentionDays ?? IMAGE_QUARANTINE_RETENTION_DAYS;
    const cutoff = new Date(this.deps.clock.now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const images = await this.deps.db.image.findMany({
      where: { status: "REJECTED", createdAt: { lt: cutoff } },
      select: { id: true, s3Key: true },
    });
    if (images.length === 0) return 0;
    await this.deps.db.image.deleteMany({ where: { id: { in: images.map((image) => image.id) } } });
    await this.enqueueDeletes(images.map((image) => image.s3Key));
    return images.length;
  }
  public async deleteObject(key: string): Promise<void> {
    await this.deps.objectStore.delete(key);
  }

  public async listOfficerImages(input: ListOfficerImagesInput): Promise<OfficerImagePage> {
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
    const images = await this.deps.db.$transaction(async (tx) => {
      const rows = await tx.image.findMany({
        where: {
          status: input.status ?? { in: ["UNSCREENED", "APPROVED", "REJECTED"] },
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        select: {
          id: true,
          purpose: true,
          status: true,
          ownerMemberId: true,
          widthPx: true,
          heightPx: true,
          bytes: true,
          s3Key: true,
          createdAt: true,
        },
      });
      const pageRows = rows.slice(0, input.limit);
      const firstRow = pageRows[0];
      if (firstRow !== undefined && this.deps.processingRecord !== undefined) {
        await this.deps.processingRecord.write(tx, {
          action: "OFFICER_IMAGES_VIEWED",
          subjectType: "IMAGE",
          subjectId: firstRow.id,
          actor: { kind: "OFFICER", id: input.officerMemberId },
          metadata: { imageIds: pageRows.map((row) => row.id) },
        });
      }
      return { rows: pageRows, hasMore: rows.length > input.limit };
    });

    const items: OfficerImageView[] = [];
    for (const row of images.rows) {
      if (row.status === "REMOVED") continue;
      items.push({
        imageId: row.id,
        status: row.status,
        purpose: row.purpose,
        ownerMemberId: row.ownerMemberId,
        widthPx: row.widthPx,
        heightPx: row.heightPx,
        bytes: row.bytes,
        createdAt: row.createdAt,
        url: await this.deps.objectStore.presignGet(row.s3Key, this.deps.config.mediaUrlTtlSeconds),
      });
    }
    const last = images.rows.at(-1);
    return {
      items,
      nextCursor: images.hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  public async removeImage(input: RemoveImageInput): Promise<void> {
    const removed = await this.deps.db.$transaction(async (tx) => {
      const image = await tx.image.findUnique({ where: { id: input.imageId } });
      if (image === null) throw new AppError("IMAGE_NOT_FOUND", 404);
      if (image.status === "REMOVED") return null;
      await tx.image.update({
        where: { id: input.imageId },
        data: {
          status: "REMOVED",
          statusReason: `OFFICER:${input.reason}`,
          removedAt: this.deps.clock.now(),
          removedBy: input.officerMemberId,
        },
      });
      await this.invokeRemovedHandlers(tx, {
        imageId: image.id,
        purpose: image.purpose,
        ownerMemberId: image.ownerMemberId,
        familyId: image.familyId,
        reason: input.reason,
        removedBy: input.officerMemberId,
      });
      if (this.deps.ownerNotification !== undefined && image.ownerMemberId !== null) {
        await this.deps.ownerNotification.postOfficerMessage(
          tx,
          image.ownerMemberId,
          "IMAGE_REMOVED",
          input.reason,
        );
      }
      if (this.deps.processingRecord !== undefined) {
        await this.deps.processingRecord.write(tx, {
          action: "IMAGE_REMOVED",
          subjectType: "IMAGE",
          subjectId: image.id,
          actor: { kind: "OFFICER", id: input.officerMemberId },
          reason: input.reason,
        });
      }
      return image.s3Key;
    });
    if (removed !== null) await this.enqueueDelete(removed);
  }

  public async approveImage(input: ApproveImageInput): Promise<void> {
    await this.deps.db.$transaction(async (tx) => {
      const image = await tx.image.findUnique({ where: { id: input.imageId } });
      if (image === null) throw new AppError("IMAGE_NOT_FOUND", 404);
      if (image.status === "APPROVED") return;
      if (image.status !== "REJECTED") throw new AppError("IMAGE_NOT_OWNED", 422);
      await tx.image.update({
        where: { id: image.id },
        data: {
          status: "APPROVED",
          statusReason: null,
          screenedAt: this.deps.clock.now(),
        },
      });
      if (this.deps.processingRecord !== undefined) {
        await this.deps.processingRecord.write(tx, {
          action: "IMAGE_OVERRIDE_APPROVED",
          subjectType: "IMAGE",
          subjectId: image.id,
          actor: { kind: "OFFICER", id: input.officerMemberId },
        });
      }
    });
  }

  private async findImage(imageId: string): Promise<ImageRecord | null> {
    return this.deps.db.image.findUnique({ where: { id: imageId } });
  }

  private validateOwnerForPurpose(owner: ImageOwner, purpose: ImagePurpose): void {
    const hasRegistration = owner.registrationId !== undefined;
    const hasMember = owner.memberId !== undefined;
    if (hasRegistration === hasMember) throw new AppError("FORBIDDEN", 403);
    if (hasRegistration && !ALLOWED_IMAGE_PURPOSES_FOR_APPLICANT.has(purpose)) {
      throw new AppError("FORBIDDEN", 403);
    }
  }
  private async prepareImage(body: Uint8Array): Promise<PreparedImage> {
    const maxBytes = this.deps.config.maxImageBytes ?? IMAGE_MAX_BYTES;
    if (body.byteLength > maxBytes) throw new AppError("IMAGE_TOO_LARGE", 413);
    if (detectImageType(body) === null) throw new AppError("IMAGE_TYPE_UNSUPPORTED", 415);

    try {
      const source = sharp(Buffer.from(body), { limitInputPixels: IMAGE_MAX_INPUT_PIXELS });
      const metadata = await source.metadata();
      if (
        !Number.isInteger(metadata.width) ||
        !Number.isInteger(metadata.height) ||
        metadata.width < 1 ||
        metadata.height < 1 ||
        metadata.width > IMAGE_MAX_INPUT_DIMENSION ||
        metadata.height > IMAGE_MAX_INPUT_DIMENSION
      ) {
        throw new AppError("IMAGE_DIMENSIONS_INVALID", 422);
      }
      const output = await source
        .rotate()
        .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      return {
        body: output.data,
        widthPx: output.info.width,
        heightPx: output.info.height,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("IMAGE_TYPE_UNSUPPORTED", 415);
    }
  }

  private async screenWithRetry(body: Uint8Array): Promise<ScreeningDecision> {
    if (this.deps.imageScreener === undefined) {
      return {
        status: "REJECTED",
        reason: "SCREENING_UNAVAILABLE",
        score: null,
        screenedAt: this.deps.clock.now(),
      };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.screenOnce(body);
        if (result.status === "REJECTED") {
          return {
            status: "REJECTED",
            reason: result.reason ?? "EXPLICIT",
            score: result.score ?? null,
            screenedAt: this.deps.clock.now(),
          };
        }
        return {
          status: "APPROVED",
          reason: null,
          score: result.score ?? null,
          screenedAt: this.deps.clock.now(),
        };
      } catch {
        continue;
      }
    }
    return {
      status: "REJECTED",
      reason: "SCREENING_UNAVAILABLE",
      score: null,
      screenedAt: this.deps.clock.now(),
    };
  }

  private async screenOnce(body: Uint8Array): Promise<ImageScreenResult> {
    const screener = this.deps.imageScreener;
    if (screener === undefined) throw new Error("Image screener is unavailable");
    if (screener.screenWithDetails !== undefined) {
      return await withTimeout(
        screener.screenWithDetails({ body, contentType: IMAGE_CONTENT_TYPE }),
        IMAGE_SCREENING_TIMEOUT_MS,
      );
    }
    const status = await withTimeout(
      screener.screen({ body, contentType: IMAGE_CONTENT_TYPE }),
      IMAGE_SCREENING_TIMEOUT_MS,
    );
    return status === "REJECTED" ? { status, reason: "EXPLICIT" } : { status };
  }

  private isViewerOwner(image: ImageRecord, viewer: MediaViewer): boolean {
    return (
      (viewer.registrationId !== undefined && image.ownerRegistrationId === viewer.registrationId) ||
      (viewer.memberId !== undefined && image.ownerMemberId === viewer.memberId)
    );
  }

  private ownerMatches(image: ImageRecord, owner: ImageOwner): boolean {
    return (
      (owner.registrationId !== undefined && image.ownerRegistrationId === owner.registrationId) ||
      (owner.memberId !== undefined && image.ownerMemberId === owner.memberId) ||
      (owner.familyId !== undefined && image.familyId === owner.familyId)
    );
  }

  private async invokeRemovedHandlers(tx: MediaTxClient, event: ImageRemovedEvent): Promise<void> {
    for (const handler of this.removedHandlers) await handler(tx, event);
  }

  private async enqueueDeletes(keys: readonly string[]): Promise<void> {
    for (const key of keys) await this.enqueueDelete(key);
  }

  private async enqueueDelete(key: string): Promise<void> {
    await this.deps.jobs.send(JOB_NAMES.deleteObject, { key }, { retryLimit: 5, retryBackoff: true });
  }
}

export const JOB_NAMES = {
  deleteObject: "media.deleteObject",
  gcOrphans: "media.gcOrphans",
  screenBacklog: "media.screenBacklog",
  purgeQuarantine: "media.purgeQuarantine",
} as const;

function detectImageType(body: Uint8Array): "JPEG" | "PNG" | "WEBP" | "HEIC" | null {
  if (body.byteLength >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "JPEG";
  if (
    body.byteLength >= 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a
  ) return "PNG";
  if (
    body.byteLength >= 12 &&
    body[0] === 0x52 &&
    body[1] === 0x49 &&
    body[2] === 0x46 &&
    body[3] === 0x46 &&
    body[8] === 0x57 &&
    body[9] === 0x45 &&
    body[10] === 0x42 &&
    body[11] === 0x50
  ) return "WEBP";
  if (
    body.byteLength >= 12 &&
    body[4] === 0x66 &&
    body[5] === 0x74 &&
    body[6] === 0x79 &&
    body[7] === 0x70
  ) {
    const brand = Buffer.from(body.subarray(8, 12)).toString("ascii").toLowerCase();
    if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "hevx" || brand === "mif1") return "HEIC";
  }
  return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Image screening timed out"));
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isCursorRecord(decoded)) throw new Error("invalid cursor");
    return { createdAt: new Date(decoded.createdAt), id: decoded.id };
  } catch {
    throw new AppError("VALIDATION_FAILED", 400, {
      issues: [{ path: ["cursor"], message: "Invalid cursor" }],
    });
  }
}

function isCursorRecord(value: unknown): value is { readonly createdAt: string; readonly id: string } {
  if (!isRecord(value)) return false;
  const createdAt = ownString(value, "createdAt");
  const id = ownString(value, "id");
  return (
    createdAt !== undefined &&
    !Number.isNaN(Date.parse(createdAt)) &&
    id !== undefined &&
    id.length > 0
  );
}

function ownString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}
