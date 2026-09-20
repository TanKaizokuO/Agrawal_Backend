export {
  EventsService,
  JOB_NAMES as EVENTS_JOB_NAMES,
  type AdmissionPage,
  type AdmissionView,
  type CreateEventValues,
  type DuplicateAdmission,
  type EventActor,
  type EventPage,
  type EventRole,
  type EventView,
  type EventsServiceDeps,
  type GateDeviceRegistration,
  type GateManifest,
  type PassPage,
  type PassView,
  type PatchEventValues,
  type SyncAdmissionsResult,
  type SyncScan,
  type VerifyPassInput,
} from "./service.js";

export {
  createEventsRoutes,
  eventsRouteManifest,
  type EventsRouteDeps,
} from "./routes.js";

export {
  createEventsWorkers,
} from "./jobs.js";

export {
  EventPassPayloadSchema,
  deterministicPassPayload,
  signEventPass,
  verifyEventPass,
  type EventPassPayload,
  type InvalidPass,
  type PassVerificationFailure,
  type PassVerificationResult,
  type VerifiedPass,
} from "./crypto.js";

export type {
  EventPassKeyPort,
  EventPassSigningKey,
  EventPassVerificationKey,
  EventsNotificationsPort,
  EventsOfficerPort,
  EventsRegisterPort,
  EventsServicePorts,
} from "./ports.js";
export type {
  AdmissionDelegate,
  AdmissionRow,
  AdmissionWhereInput,
  EventDelegate,
  EventPassDelegate,
  EventPassRow,
  EventPassWhereInput,
  EventRow,
  EventStatusType,
  EventWhereInput,
  EventsDatabase,
  EventsTxClient,
  GateDeviceDelegate,
  GateDeviceRow,
  GateDeviceWhereInput,
  PassStatusType,
} from "./db.js";

export {
  EVENT_STATUSES,
  PASS_STATUSES,
  PASS_REVOKE_REASONS,
  AdmissionsQuery,
  AdmissionListResponse,
  ClaimPassBody,
  CreateEventBody,
  EventIdAliasParams,
  EventIdParams,
  EventListResponse,
  EventResponse,
  EventsListQuery,
  GateDeviceBody,
  GateDeviceParams,
  GateDeviceResponse,
  GateManifestResponse,
  OfficerRevokePassBody,
  PassIdParams,
  PassListResponse,
  PassResponse,
  PatchEventBody,
  SyncAdmissionsBody,
  SyncAdmissionsResponse,
  type AdmissionsQueryInput,
  type ClaimPassInput,
  type CreateEventInput,
  type EventResponseBody,
  type GateManifestResponseBody,
  type OfficerRevokePassInput,
  type PassResponseBody,
  type PatchEventInput,
  type SyncAdmissionsInput,
} from "./schemas.js";

export const EVENTS_ERROR_CODES = {
  GATE_DEVICE_NOT_FOR_EVENT: "GATE_DEVICE_NOT_FOR_EVENT",
  EVENT_NOT_FOUND: "EVENT_NOT_FOUND",
  EVENT_NOT_ACTIVE: "EVENT_NOT_ACTIVE",
  EVENT_NOT_EDITABLE: "EVENT_NOT_EDITABLE",
  INVALID_EVENT_PASS: "INVALID_EVENT_PASS",
  PASS_ALREADY_EXISTS: "PASS_ALREADY_EXISTS",
  PASS_NOT_FOUND: "PASS_NOT_FOUND",
  NOT_ORGANISER: "NOT_ORGANISER",
} as const;

export type EventsErrorCode = (typeof EVENTS_ERROR_CODES)[keyof typeof EVENTS_ERROR_CODES];
