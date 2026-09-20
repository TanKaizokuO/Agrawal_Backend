import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
/**
 * Typed database interface for the Payments module.
 *
 * The delegates intentionally describe only the operations Payments owns. A
 * generated Prisma client is structurally compatible with this seam after the
 * complete schema is generated; tests can provide the same narrow adapter.
 */

// ---------- Row types (read shapes from DB) ----------

export interface PaymentRow {
  readonly id: string;
  readonly purpose: "REGISTRATION" | "BUSINESS_LISTING";
  readonly subjectId: string;
  readonly payerPhoneE164: string;
  readonly payerMemberId: string | null;
  readonly amountPaise: number;
  readonly currency: string;
  readonly status: "CREATED" | "CAPTURED" | "FAILED" | "REFUND_PENDING" | "REFUNDED";
  readonly razorpayOrderId: string;
  readonly razorpayPaymentId: string | null;
  readonly method: string | null;
  readonly identityKind: "VPA" | "CARD" | "NONE" | null;
  readonly identityHash: string | null;
  readonly identityMasked: string | null;
  readonly capturedAt: Date | null;
  readonly failedAt: Date | null;
  readonly failureReason: string | null;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly retainUntil: Date | null;
}

export interface RefundRow {
  readonly id: string;
  readonly paymentId: string;
  readonly reason:
    | "DUPLICATE_HEAD"
    | "JOIN_DECLINED"
    | "JOIN_EXPIRED"
    | "REGISTRATION_CANCELLED"
    | "REGISTRATION_ABANDONED"
    | "PUBLICATION_FAILED"
    | "OFFICER";
  readonly amountPaise: number;
  readonly razorpayRefundId: string | null;
  readonly status: "REQUESTED" | "PROCESSED" | "FAILED";
  /** On a failed refund this is also the last gateway-attempt time. */
  readonly requestedAt: Date;
  readonly processedAt: Date | null;
  readonly failureReason: string | null;
}

export interface HeadAnchorRow {
  readonly identityHash: string;
  readonly familyId: string;
  readonly paymentId: string;
  readonly createdAt: Date;
}

export interface WebhookEventRow {
  readonly eventId: string;
  readonly event: string;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly payload: unknown;
}

// ---------- Generated Prisma seam ----------
//
// Payment operations participate in the same Prisma transaction as the
// calling module. Keep this public type identical to Prisma's transaction
// client so cross-module transaction callbacks cannot drift apart.
export type PaymentTxClient = Prisma.TransactionClient;
export type PaymentDatabase = PrismaClient;
