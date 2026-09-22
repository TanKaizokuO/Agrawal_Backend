import type { WorkerRegistration } from "../../jobs.js";
import { PaymentCapturedPayload, paymentCapturedJobName } from "../payments/index.js";
import type { NoticesService } from "./service.js";

export const NOTICES_JOB_NAMES = {
  expireListings: "noticeboards.expireListings",
  endSuspensions: "noticeboards.endSuspensions",
  escalateArchivals: "noticeboards.escalateArchivals",
  paymentCaptured: paymentCapturedJobName("BUSINESS_LISTING"),
} as const;

export const JOB_SCHEDULES = {
  expireListings: {
    cron: "0 * * * *",
    timezone: "Asia/Kolkata",
    key: NOTICES_JOB_NAMES.expireListings,
  },
  endSuspensions: {
    cron: "*/15 * * * *",
    timezone: "Asia/Kolkata",
    key: NOTICES_JOB_NAMES.endSuspensions,
  },
  escalateArchivals: {
    cron: "0 * * * *",
    timezone: "Asia/Kolkata",
    key: NOTICES_JOB_NAMES.escalateArchivals,
  },
} as const;

export function createNoticesWorkers(service: NoticesService): readonly WorkerRegistration[] {
  return [
    {
      name: NOTICES_JOB_NAMES.expireListings,
      schedule: JOB_SCHEDULES.expireListings,
      handler: async () => {
        await service.expireListings();
      },
    },
    {
      name: NOTICES_JOB_NAMES.endSuspensions,
      schedule: JOB_SCHEDULES.endSuspensions,
      handler: async () => {
        await service.endSuspensions();
      },
    },
    {
      name: NOTICES_JOB_NAMES.escalateArchivals,
      schedule: JOB_SCHEDULES.escalateArchivals,
      handler: async () => {
        await service.escalateArchivals();
      },
    },
    {
      name: NOTICES_JOB_NAMES.paymentCaptured,
      handler: async (payload: unknown) => {
        const { paymentId, subjectId } = PaymentCapturedPayload.parse(payload);
        await service.onPaymentCaptured({ id: paymentId, subjectId, purpose: "BUSINESS_LISTING" });
      },
    },
  ];
}
