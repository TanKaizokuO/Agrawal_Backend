import type { Clock } from "../clock.js";
import type { WorkerRegistration } from "../jobs.js";
import {
  purgeIdempotencyRecords,
  type IdempotencyStore,
} from "./idempotency.js";

export const JOB_NAMES = {
  purgeIdempotency: "http.purgeIdempotency",
} as const;

export const JOB_SCHEDULES = {
  purgeIdempotency: {
    cron: "45 3 * * *",
    timezone: "Asia/Kolkata",
    key: JOB_NAMES.purgeIdempotency,
  },
} as const;

export function createHttpWorkers(
  store: IdempotencyStore,
  clock: Clock,
): readonly WorkerRegistration[] {
  return [
    {
      name: JOB_NAMES.purgeIdempotency,
      schedule: JOB_SCHEDULES.purgeIdempotency,
      handler: async () => {
        await purgeIdempotencyRecords(store, clock);
      },
    },
  ];
}
