import { z } from "zod";
import type { BloodGroup } from "./compatibility.js";

export const BLOOD_GROUPS = [
  "A_POS",
  "A_NEG",
  "B_POS",
  "B_NEG",
  "AB_POS",
  "AB_NEG",
  "O_POS",
  "O_NEG",
] as const satisfies readonly BloodGroup[];

export const SOS_STATUSES = ["ACTIVE", "CLOSED"] as const;
export type SosStatus = (typeof SOS_STATUSES)[number];

export const SOS_PLACE_SOURCES = ["PINCODE", "REQUESTER"] as const;
export type SosPlaceSource = (typeof SOS_PLACE_SOURCES)[number];

export const SOS_CLOSED_REASONS = [
  "FULFILLED",
  "CANCELLED",
  "EXPIRED",
  "OFFICER",
  "MEMBER_ERASED",
  "MEMBER_ARCHIVED",
] as const;
export type SosClosedReason = (typeof SOS_CLOSED_REASONS)[number];

export const BloodSosCreateBody = z.object({
  bloodGroup: z.enum(BLOOD_GROUPS),
  hospitalName: z.string().trim().min(1).max(200),
  hospitalPincode: z.string().regex(/^[1-9]\d{5}$/u),
  patientName: z.string().trim().max(120).optional(),
  unitsNeeded: z.number().int().min(1).max(20).optional(),
  note: z.string().trim().max(500).optional(),
}).strict();
export type BloodSosCreateInput = z.infer<typeof BloodSosCreateBody>;

export const BloodSosIdParams = z.object({ id: z.uuid() });
export const BloodSosReportBody = z.object({
  reason: z.string().trim().min(1).max(300),
}).strict();
export type BloodSosReportInput = z.infer<typeof BloodSosReportBody>;

export const BloodSosSnoozeBody = z.object({
  until: z.iso.date().nullable().optional(),
}).strict();
export type BloodSosSnoozeInput = z.infer<typeof BloodSosSnoozeBody>;

export const BloodSosLastDonationBody = z.object({
  donatedOn: z.iso.date().nullable(),
}).strict();
export type BloodSosLastDonationInput = z.infer<typeof BloodSosLastDonationBody>;

export const BloodSosDonorProjection = z.object({
  memberId: z.string(),
  familyPublicId: z.string().optional(),
  isHead: z.boolean().optional(),
  name: z.object({ en: z.string().nullable(), hi: z.string().nullable() }).optional(),
  gotra: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  photoUrl: z.string().nullable().optional(),
}).strict();

export const BloodSosResponseView = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  donor: BloodSosDonorProjection,
}).strict();

export const BloodSosRequestView = z.object({
  id: z.uuid(),
  status: z.enum(SOS_STATUSES),
  hospitalName: z.string(),
  hospitalCity: z.string(),
  placeSource: z.enum(SOS_PLACE_SOURCES),
  patientName: z.string().nullable(),
  unitsNeeded: z.number().int().nullable(),
  note: z.string().nullable(),
  currentTier: z.number().int().min(1).max(3),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  fulfilledAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  closedReason: z.string().nullable(),
  donorReach: z.number().int().min(0).optional(),
  responses: z.array(BloodSosResponseView).optional(),
}).strict();
export type BloodSosRequestViewBody = z.infer<typeof BloodSosRequestView>;

export const BloodSosMineResponse = z.object({
  active: BloodSosRequestView.nullable(),
  closed: z.array(BloodSosRequestView),
}).strict();

export const BloodSosDonorStatusResponse = z.object({
  isDonor: z.boolean(),
  snoozeUntil: z.iso.datetime().nullable(),
  lastDonatedOn: z.iso.date().nullable(),
  eligibleFrom: z.iso.date().nullable(),
}).strict();

export const BloodSosReportResponse = z.object({
  id: z.string(),
  status: z.literal("REPORTED"),
}).strict();
