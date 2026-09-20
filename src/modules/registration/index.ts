/**
 * Registration public interface.  Other modules consume this index only.
 */
export {
  RegistrationService,
  type RegistrationDeps,
  type RegistrationConfig,
  type RegistrationIdentityPort,
  type RegistrationOfficerPort,
  type RegistrationMediaPort,
  type RegistrationFlagKind,
  type FoundingResult,
  type JoiningResult,
  type SubmitResult,
  type FamilyCheckResult,
  type JoinRequestView,
  type Tx as RegistrationTx,
} from "./service.js";

export {
  createRegistrationRoutes,
  registrationRouteManifest,
  type RegistrationRouteDeps,
} from "./routes.js";

export {
  createRegistrationWorkers,
  JOB_NAMES as REGISTRATION_JOB_NAMES,
  JOB_SCHEDULES as REGISTRATION_JOB_SCHEDULES,
} from "./jobs.js";

export {
  BilingualName,
  SubmitBody,
  SubmittedProfile,
  FamilyCheckQuery,
  RegistrationIdParams,
  JoinRequestIdParams,
  FamilyPublicIdParams,
  RomanizeBody,
  RomanizeResponse,
  DeclineJoinBody,
  RegistrationResponse,
  FamilyCheckResponse,
  JoinRequestItem,
  JoinRequestListResponse,
  PaymentOrderResponse,
  SubmitResponse,
  type SubmitInput,
  type RegistrationResponseBody,
} from "./schemas.js";
