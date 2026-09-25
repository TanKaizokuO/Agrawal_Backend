import type { BloodSosTransaction, BloodSosService } from "./service.js";

export {
  BloodSosService,
  DEFAULT_BLOOD_SOS_CONFIG,
  projectDonorForBloodSos,
  type BloodSosConfig,
  type BloodSosDonorFilter,
  type BloodSosDonorStatus,
  type BloodSosRegisterPort,
  type BloodSosReportPort,
  type BloodSosRequesterLocation,
  type BloodSosServiceDeps,
  type BloodSosState,
  type BloodSosTransaction,
} from "./service.js";

export {
  COMPATIBLE_DONOR_GROUPS,
  compatibleDonorGroups,
  isCompatible,
  type BloodGroup,
} from "./compatibility.js";

export {
  matchBloodSosDonors,
  mayRespondToAlert,
  shouldCreateAlert,
  type BloodSosMatch,
  type BloodSosMatchingInput,
  type BloodSosMatchingPreference,
} from "./matching.js";

export {
  chooseBloodSosPlace,
  type BloodSosFallbackPlace,
  type BloodSosResolvedPlace,
} from "./places.js";
export {
  createBloodSosRoutes,
  bloodSosRouteManifest,
  type BloodSosRouteDeps,
} from "./routes.js";

export {
  createBloodSosWorkers,
  JOB_NAMES as BLOOD_SOS_JOB_NAMES,
} from "./jobs.js";

export {
  BLOOD_GROUPS,
  BloodSosCreateBody,
  BloodSosDonorProjection,
  BloodSosDonorStatusResponse,
  BloodSosIdParams,
  BloodSosLastDonationBody,
  BloodSosMineResponse,
  BloodSosReportBody,
  BloodSosReportResponse,
  BloodSosRequestView,
  BloodSosSnoozeBody,
  SOS_CLOSED_REASONS,
  SOS_PLACE_SOURCES,
  SOS_STATUSES,
  type BloodSosCreateInput,
  type BloodSosLastDonationInput,
  type BloodSosReportInput,
  type BloodSosRequestViewBody,
  type BloodSosSnoozeInput,
  type SosClosedReason,
  type SosPlaceSource,
  type SosStatus,
} from "./schemas.js";

export const BLOOD_SOS_ERROR_CODES = {
  SOS_ALREADY_ACTIVE: "SOS_ALREADY_ACTIVE",
  SOS_NOT_FOUND: "SOS_NOT_FOUND",
  SOS_ALREADY_CLOSED: "SOS_ALREADY_CLOSED",
  SOS_NOT_REQUESTER: "SOS_NOT_REQUESTER",
  SOS_NOT_ALERTED: "SOS_NOT_ALERTED",
  SOS_ALREADY_RESPONDED: "SOS_ALREADY_RESPONDED",
  SOS_PLACE_UNAVAILABLE: "SOS_PLACE_UNAVAILABLE",
} as const;

export type BloodSosErrorCode =
  (typeof BLOOD_SOS_ERROR_CODES)[keyof typeof BLOOD_SOS_ERROR_CODES];

export interface BloodSosRegisterHookPort {
  onMemberErased(
    handler: (tx: BloodSosTransaction, memberId: string) => Promise<void>,
  ): void;
  onMemberArchived(
    handler: (tx: BloodSosTransaction, memberId: string) => Promise<void>,
  ): void;
}

export function registerBloodSosHooks(
  register: BloodSosRegisterHookPort,
  service: BloodSosService,
): void {
  register.onMemberErased((tx, memberId) => service.onMemberErased(tx, memberId));
  register.onMemberArchived((tx, memberId) => service.onMemberArchived(tx, memberId));
}

export function createOfficerBloodSosAdapter(service: BloodSosService): {
  close(input: {
    readonly bloodSosId: string;
    readonly officerId: string;
    readonly reason: string;
  }): Promise<void>;
} {
  return {
    close: (input) => service.closeByOfficer(input),
  };
}

export type { BloodSosTransaction as BloodSosTxClient } from "./service.js";
