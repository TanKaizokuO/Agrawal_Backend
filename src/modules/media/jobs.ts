import { z } from "zod";
import type { WorkerRegistration } from "../../jobs.js";
import { JOB_NAMES, MediaService } from "./service.js";

const DeleteObjectPayload = z.object({ key: z.string().min(1) });

export const JOB_SCHEDULES = {
  gcOrphans: {
    cron: "0 2 * * *",
    timezone: "Asia/Kolkata",
    key: "media.gcOrphans",
  },
  screenBacklog: {
    cron: "*/5 * * * *",
    timezone: "Asia/Kolkata",
    key: "media.screenBacklog",
  },
  purgeQuarantine: {
    cron: "15 2 * * *",
    timezone: "Asia/Kolkata",
    key: "media.purgeQuarantine",
  },
} as const;

export function createMediaWorkers(service: MediaService): readonly WorkerRegistration[] {
  return [
    {
      name: JOB_NAMES.deleteObject,
      handler: async (payload: unknown) => {
        const { key } = DeleteObjectPayload.parse(payload);
        await service.deleteObject(key);
      },
    },
    {
      name: JOB_NAMES.gcOrphans,
      schedule: JOB_SCHEDULES.gcOrphans,
      handler: async () => {
        await service.gcOrphans();
      },
    },
    {
      name: JOB_NAMES.screenBacklog,
      schedule: JOB_SCHEDULES.screenBacklog,
      handler: async () => {
        await service.screenBacklog();
      },
    },
    {
      name: JOB_NAMES.purgeQuarantine,
      schedule: JOB_SCHEDULES.purgeQuarantine,
      handler: async () => {
        await service.purgeQuarantine();
      },
    },
  ];
}
