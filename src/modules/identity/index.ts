export {
  IdentityService,
  type CreatedSession,
  type IdentityServiceConfig,
  type IdentityServiceDeps,
  type ProcessingRecordWriter,
  type RegisterIdentityPort,
  type RegistrationIdentityPort,
  type RevokeReason,
} from "./service.js";

export {
  createIdentityRoutes,
  identityRouteManifest,
  type IdentityRouteDeps,
} from "./routes.js";

export {
  createIdentityWorkers,
  JOB_NAMES as IDENTITY_JOB_NAMES,
  JOB_SCHEDULES as IDENTITY_JOB_SCHEDULES,
  purgeSessions,
  type IdentityMaintenanceDeps,
  type SessionPurgeDatabase,
} from "./jobs.js";
export {
  createSmsSender,
  type SmsSenderConfig,
  type SmsSenderDeps,
} from "./sms/index.js";

export {
  CreateSessionBody,
  RequestOtpBody,
  RequestOtpResponse,
  SmsOtpAuthenticationSchema,
  AuthOtpRequest,
  AuthOtpResponse,
  AuthSessionRequest,
  AuthSessionResponse,
  MeResponse,
  Principal,
  PrincipalResponse,
  SessionClientSchema,
  SessionResponse,
  type PublicPrincipal,
  FamilyPublicId,
  PhoneE164,
  type SessionClientInput,
  type SessionResponseBody,
  type RequestOtpBodyInput,
  type CreateSessionBodyInput,
} from "./schemas.js";

export {
  parseRoleSeedArguments,
  seedRolesForPhone,
  type RoleSeedInput,
} from "./seed.js";

export {
  type IdentityDatabase,
  type IdentityRole,
  type IdentityTxClient,
  type MemberRoleDelegate,
  type MemberRoleRow,
  type SessionClient,
  type SessionDelegate,
  type SessionRow,
  type OtpChallengeDelegate,
  type OtpChallengeRow,
} from "./db.js";

export {
  IDENTITY_ERROR_CODES,
  type IdentityErrorCode,
} from "./errors.js";

