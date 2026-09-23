import { z } from "zod";
import type { PaymentPurpose } from "./service.js";

/**
 * Payload of the `payments.captured.<PURPOSE>` job that PaymentService sends
 * once a payment is captured. Consumers must parse with this schema.
 */
export const PaymentCapturedPayload = z.object({
  paymentId: z.string().min(1),
  subjectId: z.uuid(),
});

export type PaymentCapturedPayload = z.infer<typeof PaymentCapturedPayload>;

export function paymentCapturedJobName<P extends PaymentPurpose>(purpose: P): `payments.captured.${P}` {
  return `payments.captured.${purpose}`;
}
