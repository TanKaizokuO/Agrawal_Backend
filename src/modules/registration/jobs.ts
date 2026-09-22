import { z } from "zod";
import type { WorkerRegistration } from "../../jobs.js";
import { PaymentCapturedPayload, paymentCapturedJobName } from "../payments/index.js";
import type { RegistrationService } from "./service.js";

export const JOB_NAMES = {
  expireJoinRequest: "registration.expireJoinRequest",
  expireJoinRequests: "registration.expireJoinRequests",
  abandonIdle: "registration.abandonIdle",
  paymentCaptured: paymentCapturedJobName("REGISTRATION"),
} as const;

export const JOB_SCHEDULES = {
  expireJoinRequests: {
    cron: "0 * * * *",
    timezone: "Asia/Kolkata",
    key: JOB_NAMES.expireJoinRequests,
  },
  abandonIdle: {
    cron: "*/15 * * * *",
    timezone: "Asia/Kolkata",
    key: JOB_NAMES.abandonIdle,
  },
} as const;

const RegistrationIdPayload = z.object({ registrationId: z.uuid() });

export function createRegistrationWorkers(service: RegistrationService): readonly WorkerRegistration[] {
  return [
    {
      name: JOB_NAMES.expireJoinRequest,
      handler: async (payload: unknown) => {
        const { registrationId } = RegistrationIdPayload.parse(payload);
        await service.expireJoinRequest(registrationId);
      },
    },
    {
      name: JOB_NAMES.expireJoinRequests,
      schedule: JOB_SCHEDULES.expireJoinRequests,
      handler: async () => {
        await service.expireJoinRequests();
      },
    },
    {
      name: JOB_NAMES.abandonIdle,
      schedule: JOB_SCHEDULES.abandonIdle,
      handler: async () => {
        await service.abandonIdle();
      },
    },
    {
      name: JOB_NAMES.paymentCaptured,
      handler: async (payload: unknown) => {
        const { paymentId, subjectId } = PaymentCapturedPayload.parse(payload);
        await service.onRegistrationPaymentCaptured(paymentId, subjectId);
      },
    },
  ];
}
