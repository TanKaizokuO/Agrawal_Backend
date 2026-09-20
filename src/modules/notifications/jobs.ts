import { z } from "zod";
import type { WorkerRegistration } from "../../jobs.js";
import type { NotificationsService } from "./service.js";
import { NotificationJobPayload } from "./schemas.js";

export const JOB_NAMES = {
  deliver: "notifications.deliver",
  retry: "notifications.retry",
} as const;

export type NotificationJobInput = z.infer<typeof NotificationJobPayload>;

export function createNotificationWorkers(
  service: NotificationsService,
): readonly WorkerRegistration[] {
  return [
    {
      name: JOB_NAMES.deliver,
      handler: async (payload: unknown) => {
        const parsed = NotificationJobPayload.parse(payload);
        await service.deliver(parsed.message, parsed.memberIds, parsed.retry);
      },
    },
    {
      name: JOB_NAMES.retry,
      handler: async (payload: unknown) => {
        const parsed = NotificationJobPayload.parse(payload);
        await service.deliver(parsed.message, parsed.memberIds, true);
      },
    },
  ];
}
