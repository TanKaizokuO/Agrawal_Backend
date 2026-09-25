/**
 * Register module public interface.
 *
 * Other modules may import this file only.  Member columns leave Register
 * through the projection and donor interfaces below.
 */
export {
  RegisterService,
  type CreateFamilyInput,
  type CreateMemberInput,
  type NomineeReadAuthorizer,
  type PaymentsPort,
  type ProcessingActor,
  type RegisterConfig,
  type RegisterDeps,
  type RegisterProcessingAction,
  type RegisterProcessingRecordPort,
  type RegisterSuspensionResolver,
  type SuspensionResolver,
} from "./service.js";

export type { Actor } from "./schemas.js";

export {
  createRegisterRoutes,
  registerRouteManifest,
  type RegisterRouteDeps,
} from "./routes.js";

export {
  createRegisterWorkers,
  JOB_NAMES as REGISTER_JOB_NAMES,
  JOB_SCHEDULES as REGISTER_JOB_SCHEDULES,
} from "./jobs.js";

export type {
  DonorRow,
  FamilyView,
  MeResponse,
  MemberProjection,
  MemberSuspensionView,
} from "./schemas.js";
