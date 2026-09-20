import { z } from "zod";

export const ImagePurposeSchema = z.enum([
  "MEMBER_PHOTO",
  "FAMILY_PHOTO",
  "BUSINESS_PHOTO",
  "SHOK_SANDESH_PHOTO",
]);

export const ImageStatusSchema = z.enum(["UNSCREENED", "APPROVED", "REJECTED", "REMOVED"]);
export const OfficerImageStatusSchema = z.enum(["UNSCREENED", "APPROVED", "REJECTED"]);

export const ImageIdParams = z.object({ imageId: z.uuid() });
export const OfficerImagesQuery = z.object({
  status: OfficerImageStatusSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const UploadImageResponse = z.object({
  imageId: z.uuid(),
  status: z.enum(["UNSCREENED", "APPROVED"]),
  previewUrl: z.url(),
});

export const MediaUrlResponse = z.object({ url: z.url() });

export const OfficerImageViewResponse = z.object({
  imageId: z.uuid(),
  status: OfficerImageStatusSchema,
  purpose: ImagePurposeSchema,
  ownerMemberId: z.uuid().nullable(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  bytes: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  url: z.url(),
});

export const OfficerImagePageResponse = z.object({
  items: z.array(OfficerImageViewResponse),
  nextCursor: z.string().nullable(),
});

export type ImagePurposeInput = z.infer<typeof ImagePurposeSchema>;
export type OfficerImageStatusInput = z.infer<typeof OfficerImageStatusSchema>;
export type UploadImageResponseBody = z.infer<typeof UploadImageResponse>;
export type OfficerImagesQueryInput = z.infer<typeof OfficerImagesQuery>;
