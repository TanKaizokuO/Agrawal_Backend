import type {
  DeliveryResult,
  NotificationTxClient,
} from "./service.js";
import type { LocalizedPushMessage } from "./schemas.js";

/**
 * Notifications is the only public seam for device ownership and push
 * delivery. Other modules never select notification tables directly.
 */
export {
  NotificationsService,
  type DeliveryResult,
  type MemberLanguage,
  type MemberLanguageResolver,
  type NotificationTxClient,
  type NotificationsConfig,
  type NotificationsDeps,
  type RegisterDeviceResult,
} from "./service.js";

export interface NotificationsPort {
  send(
    memberIds: readonly string[],
    message: LocalizedPushMessage,
  ): Promise<Map<string, DeliveryResult>>;
  enqueue(
    memberIds: readonly string[],
    message: LocalizedPushMessage,
  ): Promise<string | null>;
  deleteTokensForMember(
    tx: NotificationTxClient,
    memberId: string,
  ): Promise<void>;
}

export {
  createNotificationRoutes,
  notificationsRouteManifest,
  type NotificationsRouteDeps,
} from "./routes.js";
export {
  createNotificationWorkers,
  JOB_NAMES as NOTIFICATION_JOB_NAMES,
  type NotificationJobInput,
} from "./jobs.js";
export {
  DevicePlatform,
  DeviceTokenParams,
  NotificationEnvironment,
  NotificationJobPayload,
  NotificationTopic,
  PushMessageSchema,
  RegisterDeviceBody,
  type DevicePlatform as DevicePlatformValue,
  type LocalizedPushMessage,
  type PushMessage,
  type NotificationEnvironment as NotificationEnvironmentValue,
  type NotificationJobInput as NotificationJobPayloadInput,
  type NotificationTopic as NotificationTopicValue,
  type RegisterDeviceInput,
} from "./schemas.js";

export type {
  FirebaseDeviceToken,
  FirebaseEnvironment,
  FirebasePlatform,
  FirebaseTokenDeliveryResult,
  FirebaseTokenDeliveryStatus,
  FirebasePushSenderOptions,
  FirebaseAdminPushSenderOptions,
  FirebaseTokenResolver,
  TokenPushSender,
} from "../../adapters/fcm.js";
