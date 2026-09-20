import { z } from "zod";
import type { JobRuntime, WorkerRegistration } from "../../jobs.js";
import type { BloodSosService } from "./service.js";

export const JOB_NAMES = {
  widenTier2: "bloodSos.widenTier2",
  widenTier3: "bloodSos.widenTier3",
  expire: "bloodSos.expire",
} as const;

const BloodSosJobPayload = z.object({
  requestId: z.uuid(),
}).strict();

export function createBloodSosWorkers(
  service: BloodSosService,
): readonly WorkerRegistration[] {
  return [
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

export async function registerBloodSosWorkers(
  runtime: JobRuntime,
  service: BloodSosService,
): Promise<void> {
  for (const worker of createBloodSosWorkers(service)) {
    await runtime.registerWorker(worker);
  }
}
