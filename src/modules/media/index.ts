import type { ImageOwner, ImagePurpose, ImageRemovedHandler } from "./service.js";
import type { MediaTxClient } from "./db.js";

export {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_INPUT_DIMENSION,
  IMAGE_MAX_INPUT_PIXELS,
  IMAGE_QUARANTINE_RETENTION_DAYS,
  MEDIA_ERROR_CODES,
  MediaService,
  JOB_NAMES as MEDIA_JOB_NAMES,
  type ApproveImageInput,
  type ImageOwner,
  type ImagePurpose,
  type ImageRemovedEvent,
  type ImageRemovedHandler,
  type ImageScreenResult,
  type ImageStatus,
  type ListOfficerImagesInput,
  type MediaImageScreener,
  type MediaObjectStore,
  type MediaOwnerNotificationPort,
  type MediaProcessingAction,
  type MediaProcessingEntry,
  type MediaProcessingRecordPort,
  type MediaServiceConfig,
  type MediaServiceDeps,
  type MediaViewer,
  type OfficerImagePage,
  type OfficerImageView,
  type RemoveImageInput,
  type UploadedImage,
  type UploadImageInput,
} from "./service.js";

export interface MediaPort {
  isVisibleToOthers(imageId: string): Promise<boolean>;
  presignUrl(imageId: string, ttlSeconds: number): Promise<string>;
  ownedBy(
    imageId: string,
    owner: ImageOwner,
    purpose?: ImagePurpose,
  ): Promise<boolean>;
  ownedByRegistration(
    imageId: string,
    registrationId: string,
    purpose?: ImagePurpose,
  ): Promise<boolean>;
  reassign(
    tx: MediaTxClient,
    imageIds: readonly string[],
    owner: { readonly ownerMemberId: string; readonly familyId?: string },
  ): Promise<void>;
  replace(
    tx: MediaTxClient,
    imageId: string,
    owner: ImageOwner,
    purpose?: ImagePurpose,
  ): Promise<void>;
  deleteOwnedByRegistration(tx: MediaTxClient, registrationId: string): Promise<void>;
  deleteAllForMember(tx: MediaTxClient, memberId: string): Promise<void>;
  onImageRemoved(handler: ImageRemovedHandler): void;
}

export type { MediaDatabase, MediaTxClient } from "./db.js";

export {
  createMediaRoutes,
  mediaRouteManifest,
  type MediaRouteDeps,
} from "./routes.js";

export {
  createMediaWorkers,
  JOB_SCHEDULES as MEDIA_JOB_SCHEDULES,
} from "./jobs.js";

export {
  ImageIdParams,
  ImagePurposeSchema,
  ImageStatusSchema,
  MediaUrlResponse,
  OfficerImagePageResponse,
  OfficerImageStatusSchema,
  OfficerImageViewResponse,
  OfficerImagesQuery,
  UploadImageResponse,
  type ImagePurposeInput,
  type OfficerImageStatusInput,
  type OfficerImagesQueryInput,
  type UploadImageResponseBody,
} from "./schemas.js";
