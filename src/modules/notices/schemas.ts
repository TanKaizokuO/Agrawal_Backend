import { z } from "zod";

export const BUSINESS_CATEGORIES = [
  "CA",
  "LEGAL",
  "SOFTWARE",
  "TEXTILES",
  "REALESTATE",
  "MEDICAL",
  "GROCERY",
  "FINANCE",
  "ARCHITECTURE",
  "EVENTS",
] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

export const NOTICE_BOARDS = ["SHOK_SANDESH", "BUSINESS_LISTING"] as const;
export type NoticeBoard = (typeof NOTICE_BOARDS)[number];

export const NOTICE_STATUSES = ["DRAFT", "ACTIVE", "HIDDEN", "EXPIRED", "REMOVED"] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

export const ARCHIVAL_REQUEST_STATUSES = ["OPEN", "CONFIRMED", "REFUTED", "ESCALATED"] as const;
export type ArchivalRequestStatus = (typeof ARCHIVAL_REQUEST_STATUSES)[number];

const Cursor = z.string().max(256).optional();
const Limit = z.coerce.number().int().min(1).max(50).default(20);

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const ShokSandeshBody = z
  .object({
    board: z.literal("SHOK_SANDESH"),
    linkedMemberId: z.uuid().nullable().optional(),
    title: z.string().trim().max(200).nullable().optional(),
    bodyHi: z.string().trim().max(2000).nullable().optional(),
    bodyEn: z.string().trim().max(2000).nullable().optional(),
    imageId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine(
    (v) => (v.bodyHi !== null && v.bodyHi !== undefined && v.bodyHi.length > 0) ||
           (v.bodyEn !== null && v.bodyEn !== undefined && v.bodyEn.length > 0),
    { message: "At least one body script is required" },
  );
export type ShokSandeshInput = z.infer<typeof ShokSandeshBody>;

export const BusinessListingBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    category: z.enum(BUSINESS_CATEGORIES),
    businessCity: z.string().trim().min(1).max(80),
    businessPhone: z.string().regex(/^\+?[0-9\s-]{7,15}$/),
    businessAddress: z.string().trim().max(300).nullable().optional(),
    bodyHi: z.string().trim().max(2000).nullable().optional(),
    bodyEn: z.string().trim().max(2000).nullable().optional(),
    imageId: z.uuid().nullable().optional(),
  })
  .strict();
export type BusinessListingInput = z.infer<typeof BusinessListingBody>;

export const ReportBody = z
  .object({
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
export type ReportInput = z.infer<typeof ReportBody>;

export const ResolveArchivalBody = z
  .object({
    outcome: z.enum(["CONFIRM", "REFUTE"] as const),
    note: z.string().trim().min(1).max(500),
  })
  .strict();
export type ResolveArchivalInput = z.infer<typeof ResolveArchivalBody>;

export const LiftSuspensionBody = z
  .object({
    reason: z.string().trim().min(1).max(500),
    restoreNotice: z.boolean(),
  })
  .strict();
export type LiftSuspensionInput = z.infer<typeof LiftSuspensionBody>;

// ---------------------------------------------------------------------------
// Query parameter schemas
// ---------------------------------------------------------------------------

export const NoticeListQuery = z.object({
  board: z.enum(["SHOK_SANDESH"]).default("SHOK_SANDESH"),
  cursor: Cursor,
  limit: Limit,
});
export type NoticeListQueryInput = z.infer<typeof NoticeListQuery>;

export const BusinessListingListQuery = z.object({
  category: z.enum(BUSINESS_CATEGORIES).optional(),
  city: z.string().trim().optional(),
  q: z.string().trim().optional(),
  ownerMemberId: z.uuid().optional(),
  cursor: Cursor,
  limit: Limit,
});
export type BusinessListingListQueryInput = z.infer<typeof BusinessListingListQuery>;

export const PaginationQuery = z.object({
  cursor: Cursor,
  limit: Limit,
});
export type PaginationQueryInput = z.infer<typeof PaginationQuery>;

export const SuspensionQuery = z.object({
  // z.coerce.boolean() would read the query string "false" as true.
  active: z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    z.boolean().default(true),
  ),
  cursor: Cursor,
  limit: Limit,
});
export type SuspensionQueryInput = z.infer<typeof SuspensionQuery>;

export const ArchivalRequestsQuery = z.object({
  status: z.enum(["OPEN", "ESCALATED", "RESOLVED"] as const).default("ESCALATED"),
  cursor: Cursor,
  limit: Limit,
});
export type ArchivalRequestsQueryInput = z.infer<typeof ArchivalRequestsQuery>;

export const ReportsQuery = z.object({
  target: z.enum(["BLOOD_SOS"] as const).default("BLOOD_SOS"),
  cursor: Cursor,
  limit: Limit,
});
export type ReportsQueryInput = z.infer<typeof ReportsQuery>;

export const NoticeIdParams = z.object({ noticeId: z.uuid() });
export const ListingIdParams = z.object({ listingId: z.uuid() });
export const ArchivalRequestIdParams = z.object({ archivalRequestId: z.uuid() });
export const SuspensionIdParams = z.object({ suspensionId: z.uuid() });
