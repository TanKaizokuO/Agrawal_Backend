import { z } from "zod";
import type { WorkerRegistration } from "../../jobs.js";
import type { BloodSosService } from "./service.js";

export const JOB_NAMES = {
  processTier1: "bloodSos.processTier1",
  processPending: "bloodSos.processPending",
  widenTier2: "bloodSos.widenTier2",
  widenTier3: "bloodSos.widenTier3",
  expire: "bloodSos.expire",
} as const;

export const JOB_SCHEDULES = {
  processPending: {
    cron: "* * * * *",
    timezone: "Asia/Kolkata",
    key: JOB_NAMES.processPending,
  },
} as const;

const BloodSosJobPayload = z.object({
  requestId: z.uuid(),
}).strict();

export function createBloodSosWorkers(
  service: BloodSosService,
): readonly WorkerRegistration[] {
  return [
    {
      name: JOB_NAMES.processTier1,
      handler: async (payload: unknown) => {
        const parsed = BloodSosJobPayload.parse(payload);
        await service.runTier(parsed.requestId, 1);
      },
    },
    {
      name: JOB_NAMES.processPending,
      schedule: JOB_SCHEDULES.processPending,
      handler: async () => service.processPendingRequests(),
    },
    {
      name: JOB_NAMES.widenTier2,
      handler: async (payload: unknown) => {
        const parsed = BloodSosJobPayload.parse(payload);
        await service.runTier(parsed.requestId, 2);
      },
    },
    {
      name: JOB_NAMES.widenTier3,
      handler: async (payload: unknown) => {
        const parsed = BloodSosJobPayload.parse(payload);
        await service.runTier(parsed.requestId, 3);
      },
    },
    {
      name: JOB_NAMES.expire,
      handler: async (payload: unknown) => {
        const parsed = BloodSosJobPayload.parse(payload);
        await service.expire(parsed.requestId);
      },
    },
  ];
}
