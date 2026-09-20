import { z } from "zod";

export const DevicePlatform = z.enum(["ANDROID", "IOS"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const NotificationEnvironment = z.enum(["local", "staging", "production"]);
export type NotificationEnvironment = z.infer<typeof NotificationEnvironment>;

export const NotificationTopic = z.enum([
  "BLOOD_SOS_ALERT",
  "BLOOD_SOS_RESPONSE",
  "JOIN_REQUEST",
  "JOIN_OUTCOME",
  "NOMINEE_PROMPT",
  "ARCHIVAL_REQUEST",
  "NOTICE_HIDDEN",
  "SUSPENSION",
  "OFFICER_MESSAGE",
  "EVENT",
]);
export type NotificationTopic = z.infer<typeof NotificationTopic>;

const LocalizedText = z.object({
  en: z.string().trim().min(1).max(500),
  hi: z.string().trim().min(1).max(500),
});

export const PushMessageSchema = z.object({
  topic: NotificationTopic,
  subjectId: z.string().trim().min(1).max(200),
  title: LocalizedText,
  body: LocalizedText,
  data: z.record(z.string().trim().min(1).max(80), z.string().max(500)).default({}),
}).strict();
export type LocalizedPushMessage = z.infer<typeof PushMessageSchema>;
export type PushMessage = LocalizedPushMessage;

export const RegisterDeviceBody = z.object({
  platform: DevicePlatform,
  appVersion: z.string().trim().min(1).max(80).optional(),
}).strict();
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceBody>;

export const DeviceTokenParams = z.object({
  token: z.string().trim().min(1).max(4096),
});

export const NotificationJobPayload = z.object({
  memberIds: z.array(z.uuid()).min(1),
  message: PushMessageSchema,
  retry: z.boolean().default(false),
});
export type NotificationJobInput = z.infer<typeof NotificationJobPayload>;
