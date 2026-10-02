import { z } from "zod";

// These values are part of the Registration wire contract.  They mirror the
// immutable Register enums without reaching into that module's implementation.
export const GOTRAS = [
  "GARG", "GOYAL", "GOYAN", "BANSAL", "KANSAL", "SINGHAL", "JINDAL",
  "TINGAL", "MOHAN", "DHARAN", "MADHUKUL", "BINDAL", "MITTAL", "TAYAL",
  "MANGAL", "AIRAN", "NANGAL", "KUCHHAL",
] as const;
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
export const BLOOD_GROUPS = [
  "A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG",
] as const;
export const GENDERS = ["FEMALE", "MALE", "OTHER"] as const;

export const REGISTRATION_STATUSES = [
  "STARTED",
  "PAID",
  "AWAITING_HEAD",
  "COMPLETED",
  "ABANDONED",
  "CANCELLED",
  "DECLINED",
  "EXPIRED",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_ROUTES = ["INDIVIDUAL", "CREATE", "JOIN"] as const;
export type RegistrationRoute = (typeof REGISTRATION_ROUTES)[number];

export const NATIVE_PLACE_IDS = [
  "AGROHA_HARYANA",
  "HISAR_HARYANA",
  "BHIWANI_HARYANA",
  "REWARI_HARYANA",
  "NARNAUL_HARYANA",
  "JHUNJHUNU_RAJASTHAN",
  "CHURU_RAJASTHAN",
  "SIKAR_RAJASTHAN",
  "FATEHPUR_SHEKHAWATI_RAJASTHAN",
  "MANDAWA_RAJASTHAN",
  "NAWALGARH_RAJASTHAN",
  "RATANGARH_RAJASTHAN",
  "MEERUT_UTTAR_PRADESH",
  "AGRA_UTTAR_PRADESH",
] as const;
export type NativePlaceId = (typeof NATIVE_PLACE_IDS)[number];

const LATIN = /^[\p{Script=Latin}\s.'-]+$/u;
const DEVANAGARI = /^[\p{Script=Devanagari}\s.]+$/u;
const FAMILY_PUBLIC_ID = /^AGR-[1-9]\d{5}-\d{5}$/u;
const PHONE_E164 = /^\+91[6-9]\d{9}$/u;

export const BilingualName = z.object({
  en: z.string().trim().min(1).max(120).regex(LATIN, "Latin script only").optional(),
  hi: z.string().trim().min(1).max(120).regex(DEVANAGARI, "Devanagari script only").optional(),
}).superRefine((value, context) => {
  if (value.en === undefined && value.hi === undefined) {
    context.addIssue({ code: "custom", message: "At least one script" });
  }
});
export type BilingualNameInput = z.infer<typeof BilingualName>;

const Address = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(80),
  state: z.enum(INDIAN_STATES),
  pincode: z.string().regex(/^[1-9]\d{5}$/u),
});

const NativePlace = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("LISTED"), id: z.enum(NATIVE_PLACE_IDS) }),
  z.object({ kind: z.literal("OTHER"), text: z.string().trim().min(1).max(120) }),
  z.object({ kind: z.literal("UNKNOWN") }),
]);

const Consents = z.object({
  directoryListing: z.literal(true),
  bloodGroupMatching: z.boolean(),
  photoVisible: z.boolean(),
});

export const SubmitBody = z.object({
  route: z.enum(REGISTRATION_ROUTES),
  familyPublicId: z.string().regex(FAMILY_PUBLIC_ID).optional(),
  uiLanguage: z.enum(["en", "hi"]),
  typingScript: z.enum(["en", "hi"]),
  name: BilingualName,
  nameEnConfirmed: z.boolean(),
  fatherOrHusbandName: BilingualName,
  gotra: z.enum(GOTRAS).optional(),
  gender: z.enum(GENDERS),
  dateOfBirth: z.iso.date(),
  bloodGroup: z.enum(BLOOD_GROUPS),
  address: Address,
  nativePlace: NativePlace,
  kuldevi: z.string().trim().max(80).optional(),
  kuldevta: z.string().trim().max(80).optional(),
  photoImageId: z.uuid().optional(),
  familyPhotoImageId: z.uuid().optional(),
  consents: Consents,
  paymentRetentionDisclosureAcknowledged: z.literal(true),
}).superRefine((value, context) => {
  const name = value.name;
  const father = value.fatherOrHusbandName;
  if (value.typingScript === "en" && name.en === undefined) {
    context.addIssue({ code: "custom", path: ["name", "en"], message: "English name is required" });
  }
  if (value.typingScript === "hi" && name.hi === undefined) {
    context.addIssue({ code: "custom", path: ["name", "hi"], message: "Hindi name is required" });
  }
  if (value.nameEnConfirmed && name.en === undefined) {
    context.addIssue({ code: "custom", path: ["nameEnConfirmed"], message: "A confirmed Latin name is required" });
  }
  if (value.typingScript === "en" && father.en === undefined) {
    context.addIssue({ code: "custom", path: ["fatherOrHusbandName", "en"], message: "English name is required" });
  }
  if (value.typingScript === "hi" && father.hi === undefined) {
    context.addIssue({ code: "custom", path: ["fatherOrHusbandName", "hi"], message: "Hindi name is required" });
  }

  if (value.route === "JOIN") {
    if (value.familyPublicId === undefined) {
      context.addIssue({ code: "custom", path: ["familyPublicId"], message: "Family ID is required when joining" });
    }
    if (value.gotra !== undefined) {
      context.addIssue({ code: "custom", path: ["gotra"], message: "Gotra is not allowed when joining" });
    }
    if (value.familyPhotoImageId !== undefined) {
      context.addIssue({ code: "custom", path: ["familyPhotoImageId"], message: "Family photo is not allowed when joining" });
    }
  } else {
    if (value.familyPublicId !== undefined) {
      context.addIssue({ code: "custom", path: ["familyPublicId"], message: "Family ID is only used when joining" });
    }
    if (value.gotra === undefined) {
      context.addIssue({ code: "custom", path: ["gotra"], message: "Gotra is required when founding" });
    }
  }
});
export type SubmitInput = z.infer<typeof SubmitBody>;

/** The persisted profile is private Registration data, not a public response. */
export const SubmittedProfile = SubmitBody;
export type SubmittedProfileInput = SubmitInput;

export const FamilyCheckQuery = z.object({
  familyPublicId: z.string().regex(FAMILY_PUBLIC_ID),
});
export type FamilyCheckInput = z.infer<typeof FamilyCheckQuery>;

export const RegistrationIdParams = z.object({ registrationId: z.uuid() });
export const JoinRequestIdParams = z.object({ registrationId: z.uuid() });
export const FamilyPublicIdParams = z.object({ publicId: z.string().regex(FAMILY_PUBLIC_ID) });
export const RomanizeBody = z.object({
  text: z.string().trim().min(1).max(120).regex(/^[\p{Script=Devanagari}\s.]+$/u),
});
export const RomanizeResponse = z.object({ latin: z.string().trim().min(1).max(240) });

export const DeclineJoinBody = z.object({
  reason: z.string().trim().max(200).optional(),
});
export type DeclineJoinInput = z.infer<typeof DeclineJoinBody>;

export const PaymentOrderResponse = z.object({
  paymentId: z.string().min(1),
  razorpayOrderId: z.string().min(1),
  keyId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  currency: z.literal("INR"),
  prefill: z.object({ contact: z.string().regex(PHONE_E164) }),
  alreadyPaid: z.boolean(),
});

const PaymentStatus = z.object({
  paymentId: z.string().min(1),
  purpose: z.literal("REGISTRATION"),
  status: z.enum(["CREATED", "CAPTURED", "FAILED", "REFUND_PENDING", "REFUNDED"]),
  amountPaise: z.number().int().nonnegative(),
  currency: z.string(),
  refund: z.object({
    status: z.enum(["REQUESTED", "PROCESSING", "PROCESSED", "FAILED"]),
    reason: z.string(),
  }).nullable(),
});

export const RegistrationResponse = z.object({
  id: z.uuid(),
  status: z.enum(REGISTRATION_STATUSES),
  route: z.enum(REGISTRATION_ROUTES).nullable(),
  payment: PaymentStatus.nullable(),
  founding: z.object({ allowed: z.boolean(), reason: z.string().optional() }),
  join: z.object({
    family: z.object({ publicId: z.string().regex(FAMILY_PUBLIC_ID), gotra: z.enum(GOTRAS) }),
    expiresAt: z.iso.datetime({ offset: true }),
    declineReason: z.string().nullable(),
  }).nullable(),
  refund: z.object({ status: z.string() }).nullable(),
  completedMemberId: z.uuid().nullable(),
});
export type RegistrationResponseBody = z.infer<typeof RegistrationResponse>;

export const FamilyCheckResponse = z.object({
  exists: z.boolean(),
  gotra: z.enum(GOTRAS).optional(),
  acceptingJoins: z.boolean().optional(),
});

export const JoinRequestItem = z.object({
  registrationId: z.uuid(),
  name: z.object({ en: z.string().nullable(), hi: z.string().nullable() }),
  fatherOrHusbandName: z.object({ en: z.string().nullable(), hi: z.string().nullable() }),
  gender: z.enum(GENDERS),
  city: z.string(),
  state: z.enum(INDIAN_STATES),
  submittedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  flags: z.array(z.string()),
});
export const JoinRequestListResponse = z.object({ items: z.array(JoinRequestItem) });

const SubmitFamily = z.object({
  publicId: z.string().regex(FAMILY_PUBLIC_ID),
  gotra: z.enum(GOTRAS),
});

export const SubmitResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("COMPLETED"),
    memberId: z.uuid(),
    family: SubmitFamily,
    completedAt: z.iso.datetime({ offset: true }),
  }),
  z.object({
    status: z.literal("AWAITING_HEAD"),
    family: SubmitFamily,
    expiresAt: z.iso.datetime({ offset: true }),
  }),
]);

export const SimpleStatusResponse = z.object({
  status: z.enum(REGISTRATION_STATUSES),
});

export type Gotra = (typeof GOTRAS)[number];
export type IndianState = (typeof INDIAN_STATES)[number];
export type BloodGroup = (typeof BLOOD_GROUPS)[number];
export type Gender = (typeof GENDERS)[number];
