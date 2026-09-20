import type { JobRuntime, WorkerRegistration } from "../../jobs.js";
import type { OfficerService } from "./service.js";

export const JOB_NAMES = {
  PURGE_PROCESSING_RECORDS: "officer.purgeProcessingRecords",
} as const;

export const JOB_SCHEDULES = {
  PURGE_PROCESSING_RECORDS: {
    cron: "15 3 * * *",
    timezone: "Asia/Kolkata",
    key: JOB_NAMES.PURGE_PROCESSING_RECORDS,
  },
} as const;

export function createOfficerWorkers(service: OfficerService): readonly WorkerRegistration[] {
  return [
    {
      name: JOB_NAMES.PURGE_PROCESSING_RECORDS,
      schedule: JOB_SCHEDULES.PURGE_PROCESSING_RECORDS,
      handler: async () => service.purgeExpiredProcessingRecords(),
    },
  ];
}

export async function registerOfficerWorkers(
  jobs: JobRuntime,
  service: OfficerService,
): Promise<void> {
  for (const registration of createOfficerWorkers(service)) {
    await jobs.registerWorker(registration);
  }
}
