import { z } from "zod";

export const EVENT_STATUSES = ["UPCOMING", "ONGOING", "ENDED", "CANCELLED"] as const;
export const PASS_STATUSES = ["ACTIVE", "REVOKED"] as const;
export const PASS_REVOKE_REASONS = [
  "EVENT_ENDED",
  "EVENT_CANCELLED",
  "MEMBER_CANCELLED",
  "MEMBER_ERASED",
  "MEMBER_ARCHIVED",
  "OFFICER",
] as const;

const Uuid = z.uuid();
const DateTime = z.iso.datetime({ offset: true });

export const EventIdParams = z.object({ id: Uuid });
export const EventIdAliasParams = z.object({ eventId: Uuid });
export const PassIdParams = z.object({ passId: Uuid });
export const GateDeviceParams = z.object({ eventId: Uuid, gateDeviceId: Uuid });

export const CreateEventBody = z.object({
  title: z.string().trim().min(1).max(200),
  titleHi: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  descriptionHi: z.string().trim().max(2000).optional(),
  venue: z.string().trim().min(1).max(200),
  venueCity: z.string().trim().min(1).max(80),
  startsAt: DateTime,
  endsAt: DateTime,
}).strict().superRefine((value, context) => {
  if (new Date(value.endsAt).getTime() <= new Date(value.startsAt).getTime()) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be after startsAt" });
  }
});
export type CreateEventInput = z.infer<typeof CreateEventBody>;

export const PatchEventBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  titleHi: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  descriptionHi: z.string().trim().max(2000).nullable().optional(),
  venue: z.string().trim().min(1).max(200).optional(),
  venueCity: z.string().trim().min(1).max(80).optional(),
  startsAt: DateTime.optional(),
  endsAt: DateTime.optional(),
}).strict().superRefine((value, context) => {
  if (value.startsAt !== undefined && value.endsAt !== undefined) {
    if (new Date(value.endsAt).getTime() <= new Date(value.startsAt).getTime()) {
      context.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be after startsAt" });
    }
  }
});
export type PatchEventInput = z.infer<typeof PatchEventBody>;

export const ClaimPassBody = z.object({
  minorsCount: z.number().int().min(0).max(20).default(0),
}).strict();
export type ClaimPassInput = z.infer<typeof ClaimPassBody>;

export const GateDeviceBody = z.object({
  label: z.string().trim().min(1).max(120),
}).strict();
export type GateDeviceInput = z.infer<typeof GateDeviceBody>;

export const SyncAdmissionsBody = z.object({
  gateDeviceId: Uuid,
  scans: z.array(z.object({
    passId: Uuid,
    scannedAt: DateTime,
  }).strict()).min(1).max(500),
}).strict();
export type SyncAdmissionsInput = z.infer<typeof SyncAdmissionsBody>;

export const EventsListQuery = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export type EventsListQueryInput = z.infer<typeof EventsListQuery>;

export const AdmissionsQuery = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type AdmissionsQueryInput = z.infer<typeof AdmissionsQuery>;

export const OfficerRevokePassBody = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();
export type OfficerRevokePassInput = z.infer<typeof OfficerRevokePassBody>;

export const EventResponse = z.object({
  id: Uuid,
  title: z.string(),
  titleHi: z.string().nullable(),
  description: z.string().nullable(),
  descriptionHi: z.string().nullable(),
  venue: z.string(),
  venueCity: z.string(),
  startsAt: DateTime,
  endsAt: DateTime,
  createdBy: Uuid,
  status: z.enum(EVENT_STATUSES),
  createdAt: DateTime,
  passCount: z.number().int().nonnegative().optional(),
});

export const EventListResponse = z.object({
  items: z.array(EventResponse),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const PassEventResponse = z.object({
  id: Uuid,
  title: z.string(),
  venue: z.string(),
  startsAt: DateTime,
  endsAt: DateTime,
});

export const PassResponse = z.object({
  passId: Uuid,
  eventId: Uuid,
  memberId: Uuid,
  familyId: Uuid,
  isHead: z.boolean(),
  minorsCount: z.number().int().min(0).max(20),
  status: z.enum(PASS_STATUSES),
  qrPayload: z.string().min(1),
  issuedAt: DateTime,
  revokedAt: DateTime.nullable(),
  revokedReason: z.string().nullable(),
  member: z.unknown().optional(),
  event: PassEventResponse,
});
export const PassListResponse = z.object({
  items: z.array(PassResponse),
  nextCursor: z.number().int().nonnegative().nullable().optional(),
});

export const GatePublicKey = z.object({
  kid: z.string().min(1),
  publicKeyPem: z.string().min(1),
});

export const GateManifestResponse = z.object({
  eventId: Uuid,
  endsAtEpoch: z.number().int().nonnegative(),
  publicKeys: z.array(GatePublicKey),
  passCount: z.number().int().nonnegative(),
  revokedPassIds: z.array(Uuid),
  generatedAt: DateTime,
});

export const GateDeviceResponse = z.object({
  gateDeviceId: Uuid,
  label: z.string(),
  eventId: Uuid,
  registeredBy: Uuid,
  registeredAt: DateTime,
  manifest: GateManifestResponse,
});

export const DuplicateAdmission = z.object({
  passId: Uuid,
  admissions: z.array(z.object({
    gateDeviceId: Uuid,
    scannedAt: DateTime,
  })),
});

export const SyncAdmissionsResponse = z.object({
  synced: z.number().int().nonnegative(),
  duplicates: z.array(DuplicateAdmission),
});

export const AdmissionResponse = z.object({
  id: Uuid,
  passId: Uuid,
  gateDeviceId: Uuid,
  scannedAt: DateTime,
  scannedOffline: z.boolean(),
  duplicate: z.boolean(),
});

export const AdmissionListResponse = z.object({
  items: z.array(AdmissionResponse),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export type EventResponseBody = z.infer<typeof EventResponse>;
export type PassResponseBody = z.infer<typeof PassResponse>;
export type GateManifestResponseBody = z.infer<typeof GateManifestResponse>;
