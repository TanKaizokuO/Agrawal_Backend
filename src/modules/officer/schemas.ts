import { z } from "zod";

export const FLAG_KINDS = [
  "NO_PAYMENT_IDENTITY",
  "POSSIBLE_DUPLICATE_PERSON",
  "SHARED_ADDRESS",
  "JOINER_PAYS_FROM_OTHER_HEAD",
] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export const FLAG_STATUSES = ["OPEN", "RESOLVED"] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

export const FLAG_RESOLUTIONS = ["CLEARED", "ERASED_MEMBER"] as const;
export type FlagResolution = (typeof FLAG_RESOLUTIONS)[number];

export const PROCESSING_ACTIONS = [
  "MEMBER_ERASED",
  "ERASURE_REQUESTED",
  "FLAG_RESOLVED",
  "IMAGE_REMOVED",
  "IMAGE_OVERRIDE_APPROVED",
  "OFFICER_IMAGES_VIEWED",
  "OFFICER_MEMBER_LOOKUP",
  "NOMINEE_READ",
  "REFUND_REQUESTED",
  "HEAD_SUCCEEDED",
  "FAMILY_ARCHIVED",
  "MEMBER_ARCHIVED",
  "MEMBER_UNARCHIVED",
  "SUSPENSION_LIFTED",
  "NOTICE_RESTORED",
  "ARCHIVAL_RESOLVED_BY_OFFICER",
  "ROLE_GRANTED",
  "ROLE_REVOKED",
  "BLOOD_SOS_REPORT_RESOLVED",
  "PASS_REVOKED",
] as const;
export type ProcessingAction = (typeof PROCESSING_ACTIONS)[number];

export const PROCESSING_ACTOR_KINDS = ["OFFICER", "OPERATOR", "MEMBER", "SYSTEM"] as const;
export type ProcessingActorKind = (typeof PROCESSING_ACTOR_KINDS)[number];

export const PROCESSING_SUBJECT_TYPES = [
  "MEMBER",
  "FAMILY",
  "IMAGE",
  "PAYMENT",
  "NOTICE",
  "FLAG",
  "REGISTRATION",
  "SUSPENSION",
  "ARCHIVAL_REQUEST",
  "BLOOD_SOS",
  "EVENT_PASS",
] as const;
export type ProcessingSubjectType = (typeof PROCESSING_SUBJECT_TYPES)[number];

const Cursor = z.string().max(256).optional();
const Limit = z.coerce.number().int().min(1).max(50).default(20);
const MemberId = z.uuid();
const FlagId = z.uuid();
const ImageId = z.uuid();
const PaymentId = z.uuid();
const ProcessingSubjectId = z.string().min(1).max(200);

export const FlagsQuery = z.object({
  status: z.enum(FLAG_STATUSES).default("OPEN"),
  cursor: Cursor,
  limit: Limit,
});
export type FlagsQueryInput = z.infer<typeof FlagsQuery>;

export const FlagIdParams = z.object({ id: FlagId });

export const ResolveFlagBody = z.object({
  outcome: z.enum(FLAG_RESOLUTIONS),
  note: z.string().trim().min(1).max(500),
});
export type ResolveFlagInput = z.infer<typeof ResolveFlagBody>;

export const ErasureRequestsQuery = z.object({
  status: z.enum(["PENDING", "EXECUTED", "WITHDRAWN"] as const).default("PENDING"),
  cursor: Cursor,
  limit: Limit,
});
export type ErasureRequestsQueryInput = z.infer<typeof ErasureRequestsQuery>;

export const EraseMemberParams = z.object({ memberId: MemberId });
export const EraseMemberBody = z.object({
  reason: z.string().trim().min(1).max(500),
  erasureRequestId: z.uuid().optional(),
});
export type EraseMemberInput = z.infer<typeof EraseMemberBody>;

export const MemberLookupQuery = z.object({
  phone: z.string().trim().min(1).max(32).optional(),
  familyPublicId: z.string().regex(/^AGR-[1-9]\d{5}-\d{5}$/u).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: Cursor,
  limit: Limit,
}).refine(
  (value) => value.phone !== undefined || value.familyPublicId !== undefined || value.q !== undefined,
  { message: "At least one lookup query is required.", path: ["q"] },
);
export type MemberLookupQueryInput = z.infer<typeof MemberLookupQuery>;

export const OfficerImagesQuery = z.object({
  status: z.enum(["UNSCREENED", "APPROVED", "REJECTED"] as const).optional(),
  cursor: Cursor,
  limit: Limit,
});
export type OfficerImagesQueryInput = z.infer<typeof OfficerImagesQuery>;

export const ImageIdParams = z.object({ imageId: ImageId });
export const RemoveImageBody = z.object({
  reason: z.string().trim().min(5).max(300),
});
export type RemoveImageInput = z.infer<typeof RemoveImageBody>;

export const PaymentIdParams = z.object({ paymentId: PaymentId });
export const RefundPaymentBody = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type RefundPaymentInput = z.infer<typeof RefundPaymentBody>;

export const ProcessingRecordQuery = z.object({
  subjectId: ProcessingSubjectId,
  cursor: Cursor,
  limit: Limit,
});
export type ProcessingRecordQueryInput = z.infer<typeof ProcessingRecordQuery>;

export const NomineeReadParams = z.object({ memberId: MemberId });
export const NomineeReadBody = z.object({
  reason: z.enum(["CONFIRMED_DEATH", "ARCHIVAL_REQUEST"] as const),
  archivalRequestId: z.uuid().optional(),
}).superRefine((value, context) => {
  if (value.reason === "ARCHIVAL_REQUEST" && value.archivalRequestId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["archivalRequestId"],
      message: "An archival request is required for this reason.",
    });
  }
});
export type NomineeReadInput = z.infer<typeof NomineeReadBody>;

export const UnarchiveParams = z.object({ memberId: MemberId });

export const SuspensionQuery = z.object({
  active: z.coerce.boolean().default(true),
  cursor: Cursor,
  limit: Limit,
});
export type SuspensionQueryInput = z.infer<typeof SuspensionQuery>;

export const SuspensionIdParams = z.object({ suspensionId: z.uuid() });
export const LiftSuspensionBody = z.object({
  reason: z.string().trim().min(1).max(500),
  restoreNotice: z.boolean(),
});
export type LiftSuspensionInput = z.infer<typeof LiftSuspensionBody>;

export const ArchivalRequestsQuery = z.object({
  status: z.enum(["OPEN", "ESCALATED", "RESOLVED"] as const).default("ESCALATED"),
  cursor: Cursor,
  limit: Limit,
});
export type ArchivalRequestsQueryInput = z.infer<typeof ArchivalRequestsQuery>;

export const ArchivalRequestIdParams = z.object({ archivalRequestId: z.uuid() });
export const ResolveArchivalBody = z.object({
  outcome: z.enum(["CONFIRM", "REFUTE"] as const),
  note: z.string().trim().min(1).max(500),
});
export type ResolveArchivalInput = z.infer<typeof ResolveArchivalBody>;

export const ReportsQuery = z.object({
  target: z.enum(["BLOOD_SOS"] as const).default("BLOOD_SOS"),
  cursor: Cursor,
  limit: Limit,
});
export type ReportsQueryInput = z.infer<typeof ReportsQuery>;

export const BloodSosIdParams = z.object({ bloodSosId: z.uuid() });
export const CloseBloodSosBody = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type CloseBloodSosInput = z.infer<typeof CloseBloodSosBody>;

export const OperatorRoleBody = z.object({
  memberId: MemberId,
  role: z.enum(["ORGANISER", "OFFICER"] as const),
  action: z.enum(["GRANT", "REVOKE"] as const),
});
export type OperatorRoleInput = z.infer<typeof OperatorRoleBody>;

export interface OfficerMemberView {
  readonly memberId: string;
  readonly familyPublicId: string;
  readonly isHead: boolean;
  readonly name?: { readonly en: string | null; readonly hi: string | null };
  readonly gotra?: string;
  readonly city?: string;
  readonly state?: string;
  readonly photoUrl?: string | null;
  readonly phoneLast4?: string;
}

export interface FlagView {
  readonly id: string;
  readonly kind: FlagKind;
  readonly status: FlagStatus;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly relatedIds: readonly string[];
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolution: string | null;
  readonly note: string | null;
  readonly subject: OfficerMemberView | null;
  readonly relatedMembers: readonly OfficerMemberView[];
}

export interface FlagPage {
  readonly items: readonly FlagView[];
  readonly nextCursor: string | null;
}

export interface ErasureRequestView {
  readonly id: string;
  readonly memberId: string;
  readonly source: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly member: OfficerMemberView | null;
}

export interface ErasureRequestPage {
  readonly items: readonly ErasureRequestView[];
  readonly nextCursor: string | null;
}

export interface MemberLookupView {
  readonly member: OfficerMemberView;
}

export interface MemberLookupPage {
  readonly items: readonly MemberLookupView[];
  readonly nextCursor: string | null;
}

export interface ProcessingRecordView {
  readonly id: string;
  readonly at: string;
  readonly actorKind: ProcessingActorKind;
  readonly actorId: string | null;
  readonly action: ProcessingAction;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly reason: string | null;
  readonly metadata: unknown;
  readonly retainUntil: string;
}

export interface ProcessingRecordPage {
  readonly items: readonly ProcessingRecordView[];
  readonly nextCursor: string | null;
}
