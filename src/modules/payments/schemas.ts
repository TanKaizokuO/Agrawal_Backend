import { z } from "zod";

const razorpayId = z.string().trim().min(1).max(200);
const razorpaySignature = z.string().regex(/^[0-9a-f]{64}$/iu);

export const ConfirmPaymentBody = z.object({
  razorpayPaymentId: razorpayId,
  razorpayOrderId: razorpayId,
  razorpaySignature,
});

export const ConfirmPaymentParams = z.object({
  paymentId: z.uuid(),
});

export const GetPaymentParams = z.object({
  paymentId: z.uuid(),
});

export const PaymentViewResponse = z.object({
  paymentId: z.uuid(),
  purpose: z.enum(["REGISTRATION", "BUSINESS_LISTING"]),
  status: z.enum(["CREATED", "CAPTURED", "FAILED", "REFUND_PENDING", "REFUNDED"]),
  amountPaise: z.number().int().nonnegative(),
  currency: z.literal("INR"),
  method: z.string().nullable(),
  capturedAt: z.iso.datetime({ offset: true }).nullable(),
  refund: z
    .object({
      status: z.enum(["REQUESTED", "PROCESSING", "PROCESSED", "FAILED"]),
      reason: z.enum([
        "DUPLICATE_HEAD",
        "JOIN_DECLINED",
        "JOIN_EXPIRED",
        "REGISTRATION_CANCELLED",
        "REGISTRATION_ABANDONED",
        "PUBLICATION_FAILED",
        "OFFICER",
      ]),
    })
    .nullable(),
});
export type ConfirmPaymentInput = z.infer<typeof ConfirmPaymentBody>;
export type PaymentViewResponseBody = z.infer<typeof PaymentViewResponse>;
