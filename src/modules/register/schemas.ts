import { z } from "zod";

// ---------------------------------------------------------------------------
// Enum value arrays — used for zod schemas and as TS const tuples.
// Must exactly match the Prisma enums in register.prisma.
// ---------------------------------------------------------------------------

export const GOTRAS = [
  "GARG", "GOYAL", "GOYAN", "BANSAL", "KANSAL", "SINGHAL", "JINDAL",
  "TINGAL", "MOHAN", "DHARAN", "MADHUKUL", "BINDAL", "MITTAL", "TAYAL",
  "MANGAL", "AIRAN", "NANGAL", "KUCHHAL",
] as const;
export type Gotra = (typeof GOTRAS)[number];

export const INDIAN_STATES = [
  "ANDHRA_PRADESH", "ARUNACHAL_PRADESH", "ASSAM", "BIHAR", "CHHATTISGARH",
  "GOA", "GUJARAT", "HARYANA", "HIMACHAL_PRADESH", "JHARKHAND", "KARNATAKA",
  "KERALA", "MADHYA_PRADESH", "MAHARASHTRA", "MANIPUR", "MEGHALAYA",
  "MIZORAM", "NAGALAND", "ODISHA", "PUNJAB", "RAJASTHAN", "SIKKIM",
  "TAMIL_NADU", "TELANGANA", "TRIPURA", "UTTAR_PRADESH", "UTTARAKHAND",
  "WEST_BENGAL", "ANDAMAN_AND_NICOBAR_ISLANDS", "CHANDIGARH",
  "DADRA_AND_NAGAR_HAVELI_AND_DAMAN_AND_DIU", "DELHI",
  "JAMMU_AND_KASHMIR", "LADAKH", "LAKSHADWEEP", "PUDUCHERRY",
] as const;
export type IndianState = (typeof INDIAN_STATES)[number];

export const BLOOD_GROUPS = [
  "A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG",
] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export const GENDERS = ["FEMALE", "MALE", "OTHER"] as const;
export type Gender = (typeof GENDERS)[number];

export const NATIVE_PLACE_KINDS = ["LISTED", "OTHER", "UNKNOWN"] as const;

export const CONSENT_TOGGLES = ["DIRECTORY", "BLOOD_GROUP", "PHOTO", "PAYMENT_DISCLOSURE_ACK"] as const;
export type ConsentToggle = (typeof CONSENT_TOGGLES)[number];

export const FAMILY_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export const MEMBER_STATUSES = ["ACTIVE", "ARCHIVED"] as const;

// ---------------------------------------------------------------------------
// Viewer relation — determines which fields are visible.
// ---------------------------------------------------------------------------
export const VIEWER_RELATIONS = ["SELF", "FAMILY", "SAMAJ"] as const;
export type ViewerRelation = (typeof VIEWER_RELATIONS)[number];

// ---------------------------------------------------------------------------
// Field allowlists per viewer relation (invariant 22 — closed default).
// A field not named here is invisible to that relation.
// ---------------------------------------------------------------------------
export const SAMAJ_FIELDS = [
  "memberId", "familyPublicId", "isHead", "name", "gotra",
  "city", "state", "photoUrl",
] as const;

export const FAMILY_FIELDS = [
  ...SAMAJ_FIELDS,
  "phoneE164", "fatherOrHusbandName",
] as const;

export const SELF_FIELDS = [
  ...FAMILY_FIELDS,
  "gender", "dateOfBirth", "address", "nativePlace", "kuldevi",
  "kuldevta", "nominee", "consents", "bloodGroup",
] as const;

export const PROJECTION_ALLOWLIST: Readonly<Record<ViewerRelation, readonly string[]>> = {
  SAMAJ: SAMAJ_FIELDS,
  FAMILY: FAMILY_FIELDS,
  SELF: SELF_FIELDS,
};

// ---------------------------------------------------------------------------
// Request / response zod schemas
// ---------------------------------------------------------------------------

export const BilingualNameSchema = z.object({
  en: z.string().trim().min(1).max(120).optional(),
  hi: z.string().trim().min(1).max(120).optional(),
}).refine((v) => v.en !== undefined || v.hi !== undefined, "At least one script");

export const PatchMeBody = z.object({
  name: BilingualNameSchema.optional(),
  nameEnConfirmed: z.boolean().optional(),
  fatherOrHusbandName: BilingualNameSchema.optional(),
  gender: z.enum(GENDERS).optional(),
  dateOfBirth: z.iso.date().optional(),
  bloodGroup: z.enum(BLOOD_GROUPS).optional(),
  address: z.object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(80),
    state: z.enum(INDIAN_STATES),
    pincode: z.string().regex(/^[1-9]\d{5}$/),
  }).optional(),
  nativePlace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("LISTED"), id: z.string().trim().min(1) }),
    z.object({ kind: z.literal("OTHER"), text: z.string().trim().min(1).max(120) }),
    z.object({ kind: z.literal("UNKNOWN") }),
  ]).optional(),
  kuldevi: z.string().trim().max(80).optional(),
  kuldevta: z.string().trim().max(80).optional(),
  uiLanguage: z.enum(["en", "hi"]).optional(),
});
export type PatchMeInput = z.infer<typeof PatchMeBody>;

export const PutConsentsBody = z.object({
  bloodGroupMatching: z.boolean(),
  photoVisible: z.boolean(),
});
export type PutConsentsInput = z.infer<typeof PutConsentsBody>;

export const PutNomineeBody = z.object({
  nomineeMemberId: z.uuid().nullable(),
});

export const PutPhotoBody = z.object({
  imageId: z.uuid().nullable(),
});

export const PutFamilyPhotoBody = z.object({
  imageId: z.uuid().nullable(),
});

export const PostErasureBody = z.object({
  firebaseIdToken: z.string().optional(),
}).optional();

export const DirectorySearchQuery = z.object({
  q: z.string().max(200).optional(),
  gotra: z.enum(GOTRAS).optional(),
  city: z.string().max(80).optional(),
  state: z.enum(INDIAN_STATES).optional(),
  familyPublicId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type DirectorySearchInput = z.infer<typeof DirectorySearchQuery>;

export const MemberIdParams = z.object({
  memberId: z.uuid(),
});

export const MessageIdParams = z.object({
  messageId: z.uuid(),
});

export const FamilyPublicIdParams = z.object({
  publicId: z.string().regex(/^AGR-[1-9]\d{5}-\d{5}$/u),
});

export const InviteCodeParams = z.object({
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{10}$/u),
});

export const OfficerNomineeReadBody = z.object({
  reason: z.enum(["CONFIRMED_DEATH", "ARCHIVAL_REQUEST"]),
  archivalRequestId: z.uuid().optional(),
}).superRefine((body, context) => {
  if (body.reason === "ARCHIVAL_REQUEST" && body.archivalRequestId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["archivalRequestId"],
      message: "An archival request is required.",
    });
  }
});
 
export const ErasureRequestResponse = z.object({
  status: z.string(),
});
 
export const InviteResponse = z.object({
  code: z.string(),
  url: z.url(),
  expiresAt: z.iso.datetime(),
});

// ---------------------------------------------------------------------------
// Projection output types
// ---------------------------------------------------------------------------

export interface BilingualName {
  readonly en: string | null;
  readonly hi: string | null;
}

export interface MemberAddress {
  readonly line1: string;
  readonly line2: string | null;
  readonly pincode: string;
  readonly district: string | null;
}

export interface MemberNativePlace {
  readonly kind: "LISTED" | "OTHER" | "UNKNOWN";
  readonly id: string | null;
  readonly text: string | null;
}

export interface MemberProjection {
  readonly memberId: string;
  readonly familyPublicId: string;
  readonly isHead: boolean;
  readonly name?: BilingualName;
  readonly gotra?: Gotra;
  readonly city?: string;
  readonly state?: IndianState;
  readonly photoUrl?: string | null;
  readonly photoStatus?: "UNSCREENED";
  readonly phoneE164?: string;
  readonly fatherOrHusbandName?: BilingualName;
  readonly gender?: Gender;
  readonly dateOfBirth?: string;
  readonly bloodGroup?: BloodGroup;
  readonly address?: MemberAddress;
  readonly nativePlace?: MemberNativePlace;
  readonly kuldevi?: string | null;
  readonly kuldevta?: string | null;
  readonly nominee?: { memberId: string | null };
  readonly consents?: {
    readonly directory: boolean;
    readonly bloodGroupMatching: boolean;
    readonly photoVisible: boolean;
  };
  // Archived member minimal projection
  readonly deceased?: true;
}

export interface DonorRow {
  readonly memberId: string;
  readonly bloodGroup: BloodGroup;
  readonly cityKey: string;
  readonly district: string | null;
  readonly state: IndianState;
}

export interface FamilyView {
  readonly familyId: string;
  readonly publicId: string;
  readonly gotra: Gotra;
  readonly status: string;
  readonly headMemberId: string | null;
  readonly memberCount: number;
  readonly photoUrl?: string | null;
}

export interface MemberSuspensionView {
  readonly endsAt: string;
  readonly reason: string;
  readonly noticeId: string | null;
}

export interface MeResponse {
  readonly self: MemberProjection;
  readonly family: {
    readonly publicId: string;
    readonly gotra: Gotra;
    readonly isHead: boolean;
    readonly memberCount: number;
  };
  readonly roles: readonly string[];
  readonly prompts: { readonly nominee: boolean };
  readonly officerMessages: readonly OfficerMessageView[];
  readonly erasureRequest: { readonly status: string } | null;
  readonly suspension: MemberSuspensionView | null;
}

export interface OfficerMessageView {
  readonly id: string;
  readonly kind: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}

// ---------------------------------------------------------------------------
// Actor type used for archival/erasure attribution.
// ---------------------------------------------------------------------------
export type Actor =
  | { readonly kind: "MEMBER"; readonly memberId: string }
  | { readonly kind: "OFFICER"; readonly officerId: string }
  | { readonly kind: "SELF" };
