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
  CreateSessionBody,
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
} from "./db.js";

export const IDENTITY_ERROR_CODES = {
  FIREBASE_TOKEN_INVALID: "FIREBASE_TOKEN_INVALID",
  FIXED_OTP_INVALID: "FIXED_OTP_INVALID",
  PHONE_BELONGS_TO_ARCHIVED_MEMBER: "PHONE_BELONGS_TO_ARCHIVED_MEMBER",
  SESSION_EXPIRED: "SESSION_EXPIRED",
} as const;

export type IdentityErrorCode =
  (typeof IDENTITY_ERROR_CODES)[keyof typeof IDENTITY_ERROR_CODES];
