import type { WorkerRegistration } from "../../jobs.js";
import type { PaymentService } from "./service.js";
import { isRecord } from "./guards.js";
import type { PaymentWebhookService } from "./webhooks.js";

export const PAYMENT_JOB_RETRY_OPTIONS = { retryLimit: 5, retryBackoff: true } as const;

export const JOB_NAMES = {
  applyWebhook: "payments.applyWebhook",
  executeRefund: "payments.executeRefund",
  reconcile: "payments.reconcile",
} as const;

export const JOB_SCHEDULES = {
  reconcile: {
    cron: "*/10 * * * *",
    timezone: "Asia/Kolkata",
    key: JOB_NAMES.reconcile,
  },
} as const;

function requiredId(payload: unknown, field: "eventId" | "refundId"): string {
  if (!isRecord(payload)) {
    throw new Error(`Invalid ${field} job payload`);
  }
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${field} job payload`);
  }
  return value;
}

export function createPaymentWorkers(
  service: PaymentService,
  webhookService: PaymentWebhookService,
): readonly WorkerRegistration[] {
  return [
    {
      name: JOB_NAMES.applyWebhook,
      handler: async (payload: unknown) => {
        await webhookService.applyWebhook(requiredId(payload, "eventId"));
      },
    },
    {
      name: JOB_NAMES.executeRefund,
      handler: async (payload: unknown) => {
        await service.executeRefund(requiredId(payload, "refundId"));
      },
    },
    {
      name: JOB_NAMES.reconcile,
      schedule: JOB_SCHEDULES.reconcile,
      handler: async () => {
        await service.reconcile();
      },
    },
  ];
}
