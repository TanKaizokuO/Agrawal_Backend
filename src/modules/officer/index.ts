import { FLAG_KINDS, PROCESSING_ACTIONS } from "./schemas.js";

/**
 * Officer is the single public seam for governance actions and the
 * append-only Processing Record. Other modules never read these tables.
 */
export {
  OfficerService,
  maskPhone,
  type OfficerArchivalPort,
  type OfficerBloodSosPort,
  type OfficerErasureRequestPort,
  type OfficerIdentityPort,
  type OfficerMediaImageView,
  type OfficerMediaPort,
  type OfficerMemberLookupPort,
  type OfficerPaymentsPort,
  type OfficerRegisterPort,
  type OfficerReportPort,
  type OfficerServiceDeps,
  type OfficerSuspensionPort,
  type OfficerTransaction,
  type ProcessingActor,
  type ProcessingEntry,
  type ProcessingMetadata,
  type ProcessingMetadataValue,
  type ProcessingRecordWriter,
} from "./service.js";

export {
  createOfficerRoutes,
  officerRouteManifest,
  type OfficerRouteDeps,
  type OfficerRouteService,
} from "./routes.js";
export {
  createOfficerWorkers,
  registerOfficerWorkers,
  JOB_NAMES as OFFICER_JOB_NAMES,
  JOB_SCHEDULES as OFFICER_JOB_SCHEDULES,
} from "./jobs.js";

export {
  FLAG_KINDS,
  FLAG_RESOLUTIONS,
  FLAG_STATUSES,
  PROCESSING_ACTIONS,
  PROCESSING_ACTOR_KINDS,
  PROCESSING_SUBJECT_TYPES,
  type EraseMemberInput,
  type ErasureRequestPage,
  type ErasureRequestsQueryInput,
  type FlagPage,
  type FlagResolution,
  type FlagStatus,
  type FlagsQueryInput,
  type FlagView,
  type MemberLookupPage,
  type MemberLookupQueryInput,
  type NomineeReadInput,
  type OfficerImagesQueryInput,
  type OfficerMemberView,
  type OperatorRoleInput,
  type ProcessingAction,
  type ProcessingActorKind,
  type ProcessingRecordPage,
  type ProcessingRecordQueryInput,
  type ProcessingSubjectType,
  type ReportsQueryInput,
  type ResolveArchivalInput,
  type ResolveFlagInput,
  type SuspensionQueryInput,
} from "./schemas.js";

export const OFFICER_ERROR_CODES = {
  FLAG_NOT_FOUND: "FLAG_NOT_FOUND",
  FLAG_ALREADY_RESOLVED: "FLAG_ALREADY_RESOLVED",
  NOMINEE_READ_NOT_PERMITTED: "NOMINEE_READ_NOT_PERMITTED",
} as const;

export type OfficerErrorCode = (typeof OFFICER_ERROR_CODES)[keyof typeof OFFICER_ERROR_CODES];

export const OFFICER_CATALOG = {
  routes: [
    "/v1/officer/flags",
    "/v1/officer/erasure-requests",
    "/v1/officer/members",
    "/v1/officer/images",
    "/v1/officer/payments/:paymentId/refund",
    "/v1/officer/processing-record",
    "/v1/operator/roles",
  ],
  processingActions: PROCESSING_ACTIONS,
  flagKinds: FLAG_KINDS,
} as const;
