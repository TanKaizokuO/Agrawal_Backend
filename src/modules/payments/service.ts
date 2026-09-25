import { createHmac, timingSafeEqual } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { Prisma } from "../../generated/prisma/client.js";
import type { Clock } from "../../clock.js";
import type { PaymentGateway, PaymentProviderPayment, PaymentRefund } from "../../adapters/ports.js";
import type { JobRuntime } from "../../jobs.js";
import { AppError } from "../../http/errors.js";
import { isNotFoundViolation, isRecord, isUniqueViolation } from "./guards.js";
import { paymentCapturedJobName } from "./events.js";
import { PAYMENT_JOB_RETRY_OPTIONS } from "./jobs.js";
import type {
  PaymentDatabase,
  PaymentRow,
  PaymentTxClient,
  RefundRow,
} from "./db.js";

// ---------- Config ----------

export interface PaymentServiceConfig {
  readonly razorpayKeyId: string;
  readonly razorpayKeySecret: string;
  readonly paymentIdentityHmacKey: string;
  readonly orderCreationClaimLeaseSeconds: number;
  readonly refundClaimLeaseSeconds: number;
  readonly outboxClaimLeaseSeconds: number;
  readonly outboxJobDedupSeconds: number;
}

// ---------- Public types ----------

export type PaymentPurpose = "REGISTRATION" | "BUSINESS_LISTING";
export type IdentityKind = "VPA" | "CARD" | "NONE";

export interface CreateOrderInput {
  readonly purpose: PaymentPurpose;
  readonly subjectId: string;
  readonly payerPhoneE164: string;
  readonly payerMemberId?: string;
  readonly amountPaise: number;
}

export interface OrderForCheckout {
  readonly paymentId: string;
  readonly razorpayOrderId: string;
  readonly keyId: string;
  readonly amountPaise: number;
  readonly currency: "INR";
  readonly prefill: { readonly contact: string };
  readonly alreadyPaid: boolean;
}

export interface PaymentView {
  readonly paymentId: string;
  readonly purpose: PaymentPurpose;
  readonly status: PaymentRow["status"];
  readonly amountPaise: number;
  readonly currency: string;
  readonly method: string | null;
  readonly capturedAt: Date | null;
  readonly refund: {
    readonly status: RefundRow["status"];
    readonly reason: RefundRow["reason"];
  } | null;
}

export interface PaymentIdentity {
  readonly kind: IdentityKind;
  readonly hash: string | null;
  readonly masked: string | null;
}

export interface PaymentViewer {
  readonly phoneE164: string;
  readonly memberId?: string;
}

export type RefundReason =
  | "DUPLICATE_HEAD"
  | "JOIN_DECLINED"
  | "JOIN_EXPIRED"
  | "REGISTRATION_CANCELLED"
  | "REGISTRATION_ABANDONED"
  | "PUBLICATION_FAILED"
  | "OFFICER";

export interface Actor {
  readonly kind: "SYSTEM" | "OFFICER";
  readonly id?: string;
}

// ---------- Identity logic ----------

export interface ExtractedIdentity {
  readonly kind: IdentityKind;
  readonly hash: string | null;
  readonly masked: string | null;
}

function computeHmac(key: string, value: string): string {
  return createHmac("sha256", Buffer.from(key, "base64")).update(value).digest("hex");
}

function maskVpa(vpa: string): string {
  const atIndex = vpa.indexOf("@");
  if (atIndex < 0) return "****";
  const handle = vpa.slice(0, atIndex);
  const suffix = vpa.slice(atIndex);
  const visible = handle.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(0, handle.length - 2))}${suffix}`;
}

export function extractIdentity(
  providerPayment: PaymentProviderPayment,
  hmacKey: string,
): ExtractedIdentity {
  const method = providerPayment.method?.trim().toLowerCase();
  if (method === "upi") {
    const normalized = providerPayment.vpa?.trim().toLowerCase();
    if (normalized !== undefined && normalized.includes("@") && !normalized.includes("*")) {
      return {
        kind: "VPA",
        hash: computeHmac(hmacKey, `VPA:${normalized}`),
        masked: maskVpa(normalized),
      };
    }
    return { kind: "NONE", hash: null, masked: null };
  }
  if (method === "card" && providerPayment.cardId !== null && providerPayment.cardId.length > 0) {
    return {
      kind: "CARD",
      hash: computeHmac(hmacKey, `CARD:${providerPayment.cardId}`),
      masked: `card ••${providerPayment.cardLast4 ?? "????"}`,
    };
  }
  return { kind: "NONE", hash: null, masked: null };
}

// ---------- Signatures ----------


export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signatureHex: string,
  keySecret: string,
): boolean {
  if (!/^[0-9a-f]{64}$/iu.test(signatureHex)) return false;
  const expected = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest();
  const received = Buffer.from(signatureHex, "hex");
  return timingSafeEqual(expected, received);
}

// ---------- Order/refund timing ----------

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Cross-module seams ----------

export interface ProcessingRecordWriter {
  write(
    tx: PaymentTxClient,
    input: {
      readonly action: "REFUND_REQUESTED";
      readonly subjectId: string;
      readonly actor: Actor;
    },
  ): Promise<void>;
}

export interface RestrictedStorageMover {
  movePayments(tx: PaymentTxClient, payerMemberId: string, retainUntil: Date): Promise<void>;
}

export interface PaymentLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface PaymentServiceDeps {
  readonly db: PaymentDatabase;
  readonly gateway: PaymentGateway;
  readonly jobs: JobRuntime;
  readonly clock: Clock;
  readonly config: PaymentServiceConfig;
  readonly processingRecord?: ProcessingRecordWriter;
  readonly restrictedStorage?: RestrictedStorageMover;
  readonly logger?: PaymentLogger;
}

export class PaymentService {
  private readonly db: PaymentDatabase;
  private readonly gateway: PaymentGateway;
  private readonly jobs: JobRuntime;
  private readonly clock: Clock;
  private readonly config: PaymentServiceConfig;
  private readonly processingRecord: ProcessingRecordWriter | undefined;
  private readonly restrictedStorage: RestrictedStorageMover | undefined;
  private readonly logger: PaymentLogger;
  // Same-instance promise sharing; PaymentOrderClaim remains the durable cross-instance source.
  private readonly inFlightOrderCreations = new Map<string, Promise<OrderForCheckout>>();

  constructor(deps: PaymentServiceDeps) {
    this.db = deps.db;
    this.gateway = deps.gateway;
    this.jobs = deps.jobs;
    this.clock = deps.clock;
    this.config = deps.config;
    this.processingRecord = deps.processingRecord;
    this.restrictedStorage = deps.restrictedStorage;
    this.logger = deps.logger ?? {
      warn: () => undefined,
      error: () => undefined,
    };
  }

  // ---- Orders ----

  async createOrder(input: CreateOrderInput): Promise<OrderForCheckout> {
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new AppError("VALIDATION_FAILED", 400);
    }

    const key = `${input.purpose}:${input.subjectId}`;
    const inFlight = this.inFlightOrderCreations.get(key);
    if (inFlight !== undefined) return inFlight;

    const creation = this.createOrderWithClaim(input);
    this.inFlightOrderCreations.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.inFlightOrderCreations.get(key) === creation) {
        this.inFlightOrderCreations.delete(key);
      }
    }
  }

  private async createOrderWithClaim(input: CreateOrderInput): Promise<OrderForCheckout> {
    const now = this.clock.now();
    const lockKey = `payment-order:${input.purpose}:${input.subjectId}`;
    const reservation = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const captured = await tx.payment.findFirst({
        where: {
          purpose: input.purpose,
          subjectId: input.subjectId,
          status: { in: ["CAPTURED", "REFUND_PENDING"] },
        },
      });
      if (captured !== null) {
        return { payment: captured, alreadyPaid: true } as const;
      }

      const cutoff = new Date(now.getTime() - THIRTY_MINUTES_MS);
      const recent = await tx.payment.findFirst({
        where: {
          purpose: input.purpose,
          subjectId: input.subjectId,
          status: "CREATED",
          createdAt: { gte: cutoff },
        },
        orderBy: { createdAt: "desc" },
      });
      if (recent !== null) {
        return { payment: recent, alreadyPaid: false } as const;
      }

      const claimKey = { purpose: input.purpose, subjectId: input.subjectId };
      const existingClaim = await tx.paymentOrderClaim.findUnique({
        where: { purpose_subjectId: claimKey },
      });
      if (existingClaim !== null) {
        if (now.getTime() - existingClaim.attemptedAt.getTime() < this.config.orderCreationClaimLeaseSeconds * 1000) {
          throw new AppError("UPSTREAM_UNAVAILABLE", 503);
        }
        const claimed = await tx.paymentOrderClaim.updateMany({
          where: { ...claimKey, attemptedAt: existingClaim.attemptedAt },
          data: { attemptedAt: now },
        });
        if (claimed.count === 0) throw new AppError("UPSTREAM_UNAVAILABLE", 503);
        return { claim: { ...existingClaim, attemptedAt: now }, recovering: true } as const;
      }

      const claim = await tx.paymentOrderClaim.create({
        data: {
          purpose: input.purpose,
          subjectId: input.subjectId,
          paymentId: uuidv7(),
          amountPaise: input.amountPaise,
          attemptedAt: now,
        },
      });
      return { claim, recovering: false } as const;
    });
    if ("payment" in reservation) {
      return this.checkoutOrder(
        reservation.payment,
        input.payerPhoneE164,
        reservation.alreadyPaid === true,
      );
    }

    const { claim, recovering } = reservation;
    const providerOrder = (recovering ? await this.gateway.findOrderByReceipt(claim.paymentId) : null)
      ?? await this.gateway.createOrder({
        amountPaise: claim.amountPaise,
        currency: "INR",
        receipt: claim.paymentId,
        notes: { purpose: claim.purpose, subjectId: claim.subjectId },
      });
    if (
      providerOrder.providerOrderId.length === 0
      || !Number.isSafeInteger(providerOrder.amountPaise)
      || providerOrder.amountPaise <= 0
    ) {
      throw new AppError("UPSTREAM_UNAVAILABLE", 503);
    }

    const payment = await this.db.$transaction(async (tx) => {
      const activeClaim = await tx.paymentOrderClaim.findUnique({
        where: { purpose_subjectId: { purpose: claim.purpose, subjectId: claim.subjectId } },
      });
      if (activeClaim === null) {
        const existing = await tx.payment.findUnique({ where: { id: claim.paymentId } });
        if (existing !== null) return existing;
        throw new AppError("UPSTREAM_UNAVAILABLE", 503);
      }
      if (activeClaim.attemptedAt.getTime() !== claim.attemptedAt.getTime()) {
        throw new AppError("UPSTREAM_UNAVAILABLE", 503);
      }
      const created = await tx.payment.create({
        data: {
          id: claim.paymentId,
          purpose: claim.purpose,
          subjectId: claim.subjectId,
          payerPhoneE164: input.payerPhoneE164,
          payerMemberId: input.payerMemberId ?? null,
          amountPaise: providerOrder.amountPaise,
          currency: "INR",
          status: "CREATED",
          razorpayOrderId: providerOrder.providerOrderId,
        },
      });
      await tx.paymentOrderClaim.delete({
        where: { purpose_subjectId: { purpose: claim.purpose, subjectId: claim.subjectId } },
      });
      return created;
    });
    return this.checkoutOrder(payment, input.payerPhoneE164, false);
  }

  private checkoutOrder(
    payment: PaymentRow,
    payerPhoneE164: string,
    alreadyPaid: boolean,
  ): OrderForCheckout {
    return {
      paymentId: payment.id,
      razorpayOrderId: payment.razorpayOrderId,
      keyId: this.config.razorpayKeyId,
      amountPaise: payment.amountPaise,
      currency: "INR",
      prefill: { contact: payerPhoneE164 },
      alreadyPaid,
    };
  }

  // ---- Fast-path confirmation ----

  async confirmPayment(
    paymentId: string,
    body: { readonly razorpayPaymentId: string; readonly razorpayOrderId: string; readonly razorpaySignature: string },
  ): Promise<PaymentView> {
    const payment = await this.db.payment.findUnique({ where: { id: paymentId } });
    if (payment === null) throw new AppError("PAYMENT_NOT_FOUND", 404);
    return this.confirmPaymentForRow(payment, body);
  }

  async confirmPaymentForPrincipal(
    paymentId: string,
    body: { readonly razorpayPaymentId: string; readonly razorpayOrderId: string; readonly razorpaySignature: string },
    viewer: PaymentViewer,
  ): Promise<PaymentView> {
    const payment = await this.paymentForViewer(paymentId, viewer);
    return this.confirmPaymentForRow(payment, body);
  }

  private async confirmPaymentForRow(
    payment: PaymentRow,
    body: { readonly razorpayPaymentId: string; readonly razorpayOrderId: string; readonly razorpaySignature: string },
  ): Promise<PaymentView> {
    if (
      body.razorpayOrderId !== payment.razorpayOrderId ||
      !verifyCheckoutSignature(
        body.razorpayOrderId,
        body.razorpayPaymentId,
        body.razorpaySignature,
        this.config.razorpayKeySecret,
      )
    ) {
      throw new AppError("PAYMENT_SIGNATURE_INVALID", 400);
    }

    const providerPayment = await this.gateway.fetchPayment(body.razorpayPaymentId);
    if (
      providerPayment.orderId !== payment.razorpayOrderId ||
      (providerPayment.amountPaise !== null && providerPayment.amountPaise !== payment.amountPaise)
    ) {
      throw new AppError("PAYMENT_SIGNATURE_INVALID", 400);
    }

    await this.applyProviderPayment(payment, providerPayment);
    return this.getView(payment.id);
  }

  // ---- Provider state application ----

  private async applyProviderPayment(
    payment: PaymentRow,
    provider: PaymentProviderPayment,
  ): Promise<void> {
    if (provider.orderId !== payment.razorpayOrderId) return;
    if (
      provider.amountPaise !== null &&
      provider.amountPaise !== payment.amountPaise
    ) {
      return;
    }
    if (provider.status === "captured") {
      await this.applyCapture(provider);
    } else if (provider.status === "failed") {
      await this.applyFailure(provider);
    }
  }

  // Provider-state effects shared with PaymentWebhookService and reconciliation.
  async applyCapture(provider: PaymentProviderPayment): Promise<void> {
    const orderId = provider.orderId;
    if (orderId === null || provider.id.length === 0) return;

    const eventKey = await this.db.$transaction(async (tx): Promise<string | null> => {
      const payment = await tx.payment.findUnique({ where: { razorpayOrderId: orderId } });
      if (payment === null) return null;
      if (
        provider.amountPaise !== null &&
        provider.amountPaise !== payment.amountPaise
      ) {
        this.logger.warn(
          { paymentId: payment.id, providerPaymentId: provider.id },
          "PAYMENT_AMOUNT_MISMATCH",
        );
        return null;
      }
      if (
        payment.razorpayPaymentId !== null &&
        payment.razorpayPaymentId !== provider.id
      ) {
        return null;
      }

      switch (payment.status) {
        case "CREATED":
        case "FAILED": {
          const identity = extractIdentity(provider, this.config.paymentIdentityHmacKey);
          const changed = await tx.payment.updateMany({
            where: { id: payment.id, status: { in: ["CREATED", "FAILED"] } },
            data: {
              status: "CAPTURED",
              razorpayPaymentId: provider.id,
              method: provider.method,
              identityKind: identity.kind,
              identityHash: identity.hash,
              identityMasked: identity.masked,
              capturedAt: this.clock.now(),
              failedAt: null,
              failureReason: null,
            },
          });
          if (changed.count === 0) return null;
          break;
        }
        case "CAPTURED":
        case "REFUND_PENDING":
        case "REFUNDED":
          break;
        default:
          return null;
      }

      if (payment.consumedAt !== null) return null;
      const capturedEventKey = `payments.captured:${payment.id}`;
      await this.recordOutboxJob(tx, {
        eventKey: capturedEventKey,
        jobName: paymentCapturedJobName(payment.purpose),
        payload: { paymentId: payment.id, subjectId: payment.subjectId },
      });
      return capturedEventKey;
    });
    if (eventKey !== null) await this.dispatchOutboxJob(eventKey);
  }

  async applyFailure(provider: PaymentProviderPayment): Promise<void> {
    if (provider.orderId === null || provider.id.length === 0) return;
    const payment = await this.db.payment.findUnique({
      where: { razorpayOrderId: provider.orderId },
    });
    if (payment === null) return;

    await this.db.payment.updateMany({
      where: { id: payment.id, status: "CREATED" },
      data: {
        status: "FAILED",
        failedAt: this.clock.now(),
        failureReason: provider.errorDescription ?? "payment_failed",
      },
    });
  }

  async applyProviderRefundStatus(
    refundId: string,
    attemptNumber: number,
    providerRefundId: string,
    providerStatus: string,
    expectedClaimAt?: Date,
    failureReason?: string | null,
  ): Promise<void> {
    const result = await this.db.$transaction(async (tx) => {
      const refund = await tx.refund.findUnique({ where: { id: refundId } });
      if (refund === null || refund.attemptNumber !== attemptNumber) return null;
      if (
        expectedClaimAt !== undefined &&
        (
          refund.status !== "PROCESSING" ||
          refund.processingStartedAt?.getTime() !== expectedClaimAt.getTime()
        )
      ) {
        return null;
      }
      if (refund.status === "PROCESSED") return null;

      const attempt = await tx.refundAttempt.findUnique({
        where: { refundId_attemptNumber: { refundId, attemptNumber } },
      });
      if (attempt === null) return null;
      if (
        attempt.razorpayRefundId !== null &&
        attempt.razorpayRefundId !== providerRefundId
      ) {
        return null;
      }
      if (attempt.razorpayRefundId === null) {
        const assigned = await tx.refundAttempt.updateMany({
          where: { refundId, attemptNumber, razorpayRefundId: null },
          data: { razorpayRefundId: providerRefundId },
        });
        if (assigned.count === 0) {
          const currentAttempt = await tx.refundAttempt.findUnique({
            where: { refundId_attemptNumber: { refundId, attemptNumber } },
          });
          if (currentAttempt?.razorpayRefundId !== providerRefundId) return null;
        }
      }

      const payment = await tx.payment.findUnique({ where: { id: refund.paymentId } });
      if (payment === null) return null;

      if (providerStatus === "processed") {
        const changed = await tx.refund.updateMany({
          where: {
            id: refund.id,
            attemptNumber,
            status: { not: "PROCESSED" },
            ...(expectedClaimAt === undefined ? {} : { processingStartedAt: expectedClaimAt }),
          },
          data: {
            status: "PROCESSED",
            processedAt: this.clock.now(),
            processingStartedAt: null,
            failureReason: null,
            razorpayRefundId: providerRefundId,
          },
        });
        if (changed.count === 0) return null;
        await tx.payment.updateMany({
          where: { id: payment.id, status: { not: "REFUNDED" } },
          data: { status: "REFUNDED" },
        });
        const eventKey = `payments.refunded:${payment.id}`;
        await this.recordOutboxJob(tx, {
          eventKey,
          jobName: `payments.refunded.${payment.purpose}`,
          payload: { paymentId: payment.id, subjectId: payment.subjectId },
        });
        return { eventKey, paymentId: payment.id, shouldLogFailure: false };
      }

      const changed = await tx.refund.updateMany({
        where: {
          id: refund.id,
          attemptNumber,
          status: { not: "PROCESSED" },
          ...(expectedClaimAt === undefined ? {} : { processingStartedAt: expectedClaimAt }),
        },
        data: {
          status: providerStatus === "failed" ? "FAILED" : "REQUESTED",
          requestedAt: this.clock.now(),
          processingStartedAt: null,
          failureReason: providerStatus === "failed" ? failureReason ?? "refund_failed" : null,
          razorpayRefundId: providerRefundId,
        },
      });
      return changed.count === 0
        ? null
        : {
            eventKey: null,
            paymentId: payment.id,
            shouldLogFailure: providerStatus === "failed",
          };
    });
    if (result === null) return;
    if (result.shouldLogFailure) {
      this.logger.error(
        { refundId, attemptNumber, paymentId: result.paymentId },
        "REFUND_FAILED",
      );
    }
    if (result.eventKey !== null) await this.dispatchOutboxJob(result.eventKey);
  }

  private async recordOutboxJob(
    tx: PaymentTxClient | PaymentDatabase,
    input: {
      readonly eventKey: string;
      readonly jobName: string;
      readonly payload: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.paymentOutboxJob.upsert({
      where: { eventKey: input.eventKey },
      create: {
        id: uuidv7(),
        eventKey: input.eventKey,
        jobName: input.jobName,
        payload: input.payload,
      },
      update: {},
    });
  }
  private async recordRefundExecutionOutbox(
    tx: PaymentTxClient,
    refundId: string,
    attemptNumber: number,
  ): Promise<void> {
    const eventKey = `payments.executeRefund:${refundId}:${attemptNumber.toString()}`;
    await this.recordOutboxJob(tx, {
      eventKey,
      jobName: "payments.executeRefund",
      payload: { refundId },
    });
    await tx.paymentOutboxJob.updateMany({
      where: { eventKey, dispatchedAt: { not: null } },
      data: { claimedAt: null, dispatchedAt: null },
    });
  }

  private async dispatchOutboxJob(eventKey: string): Promise<void> {
    const now = this.clock.now();
    const claimed = await this.db.$transaction(async (tx) => {
      const event = await tx.paymentOutboxJob.findUnique({ where: { eventKey } });
      if (event === null || event.dispatchedAt !== null) return null;
      if (
        event.claimedAt !== null &&
        now.getTime() - event.claimedAt.getTime() < this.config.outboxClaimLeaseSeconds * 1000
      ) {
        return null;
      }
      const update = await tx.paymentOutboxJob.updateMany({
        where: { id: event.id, dispatchedAt: null, claimedAt: event.claimedAt },
        data: { claimedAt: now },
      });
      return update.count === 0 ? null : event;
    });
    if (claimed === null) return;

    try {
      await this.jobs.send(claimed.jobName, claimed.payload, {
        ...PAYMENT_JOB_RETRY_OPTIONS,
        singletonKey: claimed.eventKey,
        singletonSeconds: this.config.outboxJobDedupSeconds,
      });
      await this.db.paymentOutboxJob.updateMany({
        where: { id: claimed.id, claimedAt: now, dispatchedAt: null },
        data: { claimedAt: null, dispatchedAt: this.clock.now() },
      });
    } catch (error: unknown) {
      await this.db.paymentOutboxJob.updateMany({
        where: { id: claimed.id, claimedAt: now, dispatchedAt: null },
        data: { claimedAt: null },
      });
      throw error;
    }
  }


  async refund(
    tx: PaymentTxClient,
    paymentId: string,
    reason: RefundReason,
    actor: Actor,
  ): Promise<void> {
    const existing = await tx.refund.findUnique({ where: { paymentId } });
    if (existing !== null) return;

    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (payment === null) throw new AppError("PAYMENT_NOT_FOUND", 404);
    if (payment.status !== "CAPTURED" && payment.status !== "REFUND_PENDING") return;

    const refundId = uuidv7();
    try {
      await tx.refund.create({
        data: {
          id: refundId,
          paymentId,
          reason,
          amountPaise: payment.amountPaise,
          status: "REQUESTED",
        },
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) return;
      throw error;
    }

    await tx.payment.update({
      where: { id: paymentId },
      data: { status: "REFUND_PENDING" },
    });
    if (this.processingRecord !== undefined) {
      await this.processingRecord.write(tx, {
        action: "REFUND_REQUESTED",
        subjectId: paymentId,
        actor,
      });
    }

    await this.recordRefundExecutionOutbox(tx, refundId, 0);
  }

  async executeRefund(refundId: string): Promise<void> {
    const now = this.clock.now();
    const claimed = await this.db.$transaction(async (tx) => {
      const lockKey = `payment-refund:${refundId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const refund = await tx.refund.findUnique({ where: { id: refundId } });
      if (
        refund === null ||
        (refund.status !== "REQUESTED" &&
          refund.status !== "PROCESSING" &&
          refund.status !== "FAILED") ||
        refund.razorpayRefundId !== null ||
        (
          refund.status === "FAILED" &&
          now.getTime() - refund.requestedAt.getTime() < ONE_DAY_MS
        ) ||
        (
          refund.processingStartedAt !== null &&
          now.getTime() - refund.processingStartedAt.getTime() <
            this.config.refundClaimLeaseSeconds * 1000
        )
      ) {
        return null;
      }

      const claim = await tx.refund.updateMany({
        where: {
          id: refund.id,
          status: refund.status,
          razorpayRefundId: null,
          requestedAt: refund.requestedAt,
          processingStartedAt: refund.processingStartedAt,
          attemptNumber: refund.attemptNumber,
        },
        data: {
          status: "PROCESSING",
          processingStartedAt: now,
          failureReason: null,
        },
      });
      if (claim.count === 0) return null;

      const payment = await tx.payment.findUnique({ where: { id: refund.paymentId } });
      if (payment === null || payment.razorpayPaymentId === null) {
        await tx.refund.updateMany({
          where: { id: refund.id, status: "PROCESSING", processingStartedAt: now },
          data: {
            status: refund.status === "FAILED" ? "FAILED" : "REQUESTED",
            processingStartedAt: null,
            failureReason: refund.failureReason,
          },
        });
        return null;
      }

      await tx.refundAttempt.upsert({
        where: {
          refundId_attemptNumber: {
            refundId: refund.id,
            attemptNumber: refund.attemptNumber,
          },
        },
        create: { refundId: refund.id, attemptNumber: refund.attemptNumber },
        update: {},
      });

      return {
        refundId: refund.id,
        paymentId: payment.id,
        providerPaymentId: payment.razorpayPaymentId,
        amountPaise: refund.amountPaise,
        reason: refund.reason,
        attemptNumber: refund.attemptNumber,
        startedAt: now,
      };
    });
    if (claimed === null) return;

    let result: PaymentRefund;
    try {
      result = await this.gateway.refund({
        providerPaymentId: claimed.providerPaymentId,
        amountPaise: claimed.amountPaise,
        speed: "normal",
        notes: { reason: claimed.reason },
        idempotencyKey: claimed.attemptNumber === 0
          ? claimed.refundId
          : `${claimed.refundId}-${claimed.attemptNumber.toString()}`,
      });
    } catch (error: unknown) {
      await this.db.refund.updateMany({
        where: {
          id: claimed.refundId,
          attemptNumber: claimed.attemptNumber,
          status: "PROCESSING",
          razorpayRefundId: null,
          processingStartedAt: claimed.startedAt,
        },
        data: {
          status: "FAILED",
          requestedAt: this.clock.now(),
          processingStartedAt: null,
          failureReason: error instanceof Error ? error.message : "refund_failed",
        },
      });
      throw error instanceof Error ? error : new Error("refund_failed");
    }
    await this.applyProviderRefundStatus(
      claimed.refundId,
      claimed.attemptNumber,
      result.providerRefundId,
      result.status,
      claimed.startedAt,
    );
  }
  // ---- Queries and authorization ----

  async getForSubject(subjectId: string): Promise<PaymentView | null> {
    const payment = await this.db.payment.findFirst({
      where: { subjectId, status: { not: "FAILED" } },
      orderBy: { createdAt: "desc" },
    });
    if (payment === null) return null;
    return this.buildView(payment);
  }

  async getView(paymentId: string): Promise<PaymentView> {
    const payment = await this.db.payment.findUnique({ where: { id: paymentId } });
    if (payment === null) throw new AppError("PAYMENT_NOT_FOUND", 404);
    return this.buildView(payment);
  }

  async getViewForPrincipal(paymentId: string, viewer: PaymentViewer): Promise<PaymentView> {
    return this.buildView(await this.paymentForViewer(paymentId, viewer));
  }

  private async paymentForViewer(paymentId: string, viewer: PaymentViewer): Promise<PaymentRow> {
    const payment = await this.db.payment.findUnique({ where: { id: paymentId } });
    if (payment === null) throw new AppError("PAYMENT_NOT_FOUND", 404);
    const memberMatches =
      viewer.memberId !== undefined && payment.payerMemberId === viewer.memberId;
    const applicantMatches =
      payment.payerMemberId === null && payment.payerPhoneE164 === viewer.phoneE164;
    if (!memberMatches && !applicantMatches) throw new AppError("FORBIDDEN", 403);
    return payment;
  }

  private async buildView(payment: PaymentRow): Promise<PaymentView> {
    const refund = await this.db.refund.findUnique({ where: { paymentId: payment.id } });
    return {
      paymentId: payment.id,
      purpose: payment.purpose,
      status: payment.status,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      method: payment.method,
      capturedAt: payment.capturedAt,
      refund: refund === null ? null : { status: refund.status, reason: refund.reason },
    };
  }

  // ---- Payment Identity ----

  async identityOf(paymentId: string): Promise<PaymentIdentity> {
    const payment = await this.db.payment.findUnique({ where: { id: paymentId } });
    if (payment === null) throw new AppError("PAYMENT_NOT_FOUND", 404);
    return {
      kind: payment.identityKind ?? "NONE",
      hash: payment.identityHash,
      masked: payment.identityMasked,
    };
  }

  // ---- HeadAnchor ----

  async findHeadAnchor(identityHash: string): Promise<{ familyId: string } | null> {
    const anchor = await this.db.headAnchor.findUnique({ where: { identityHash } });
    return anchor === null ? null : { familyId: anchor.familyId };
  }

  async createHeadAnchor(
    tx: PaymentTxClient,
    input: { readonly identityHash: string; readonly familyId: string; readonly paymentId: string },
  ): Promise<void> {
    try {
      await tx.headAnchor.create({ data: input });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new AppError("DUPLICATE_HEAD", 409);
      throw error;
    }
  }

  async releaseHeadAnchor(tx: PaymentTxClient, familyId: string): Promise<void> {
    try {
      await tx.headAnchor.delete({ where: { familyId } });
    } catch (error: unknown) {
      if (!isNotFoundViolation(error)) throw error;
    }
  }

  // ---- Consumption and restricted erasure ----

  async markConsumed(tx: PaymentTxClient, paymentId: string): Promise<void> {
    await tx.payment.updateMany({
      where: { id: paymentId, consumedAt: null },
      data: { consumedAt: this.clock.now() },
    });
  }

  async moveToRestricted(
    tx: PaymentTxClient,
    payerMemberId: string,
    retainUntil: Date,
  ): Promise<void> {
    if (this.restrictedStorage === undefined) {
      throw new AppError("INTERNAL", 500);
    }
    await this.restrictedStorage.movePayments(tx, payerMemberId, retainUntil);
  }

  // ---- Reconciliation ----

  async reconcile(): Promise<void> {
    const now = this.clock.now();
    const fiveMinAgo = new Date(now.getTime() - FIVE_MINUTES_MS);
    const oneHourAgo = new Date(now.getTime() - ONE_HOUR_MS);
    const oneDayAgo = new Date(now.getTime() - ONE_DAY_MS);
    const fortyEightHoursAgo = new Date(now.getTime() - FORTY_EIGHT_HOURS_MS);
    const expiredRefundLeaseAt = new Date(
      now.getTime() - this.config.refundClaimLeaseSeconds * 1000,
    );
    const expiredOutboxLeaseAt = new Date(
      now.getTime() - this.config.outboxClaimLeaseSeconds * 1000,
    );

    const staleCreated = await this.db.payment.findMany({
      where: {
        status: "CREATED",
        createdAt: { gte: fortyEightHoursAgo, lte: fiveMinAgo },
      },
    });
    for (const payment of staleCreated) {
      try {
        const orderPayments = await this.gateway.fetchOrderPayments(payment.razorpayOrderId);
        const captured = orderPayments.find((candidate) => candidate.status === "captured");
        if (captured !== undefined) {
          this.logger.error(
            { paymentId: payment.id, razorpayPaymentId: captured.id },
            "WEBHOOK_MISSED",
          );
          const provider = withOrderId(captured, payment.razorpayOrderId);
          if (provider !== null) await this.applyCapture(provider);
          continue;
        }

        const authorized = orderPayments.find((candidate) => candidate.status === "authorized");
        if (authorized !== undefined) {
          this.logger.error(
            { paymentId: payment.id, razorpayPaymentId: authorized.id },
            "WEBHOOK_MISSED",
          );
          const capturedPayment = await this.gateway.capture({
            providerPaymentId: authorized.id,
            amountPaise: payment.amountPaise,
          });
          const provider = withOrderId(capturedPayment, payment.razorpayOrderId);
          if (provider !== null && provider.status === "captured") {
            await this.applyCapture(provider);
          }
        }
      } catch (error: unknown) {
        this.logger.error(
          { paymentId: payment.id, err: error },
          "PAYMENT_RECONCILE_FAILED",
        );
      }
    }

    const abandoned = await this.db.payment.findMany({
      where: { status: "CREATED", createdAt: { lt: fortyEightHoursAgo } },
    });
    for (const payment of abandoned) {
      try {
        await this.db.payment.updateMany({
          where: { id: payment.id, status: "CREATED" },
          data: {
            status: "FAILED",
            failedAt: now,
            failureReason: "ORDER_ABANDONED",
          },
        });
      } catch (error: unknown) {
        this.logger.error(
          { paymentId: payment.id, err: error },
          "PAYMENT_RECONCILE_FAILED",
        );
      }
    }

    const unconsumedCaptures = await this.db.payment.findMany({
      where: {
        status: { in: ["CAPTURED", "REFUND_PENDING", "REFUNDED"] },
        consumedAt: null,
      },
    });
    for (const payment of unconsumedCaptures) {
      const eventKey = `payments.captured:${payment.id}`;
      try {
        await this.recordOutboxJob(this.db, {
          eventKey,
          jobName: paymentCapturedJobName(payment.purpose),
          payload: { paymentId: payment.id, subjectId: payment.subjectId },
        });
        await this.db.paymentOutboxJob.updateMany({
          where: {
            eventKey,
            dispatchedAt: { lte: oneHourAgo },
          },
          data: { claimedAt: null, dispatchedAt: null },
        });
        await this.dispatchOutboxJob(eventKey);
      } catch (error: unknown) {
        this.logger.error(
          { paymentId: payment.id, eventKey, err: error },
          "PAYMENT_RECONCILE_FAILED",
        );
      }
    }

    const staleRefunds = await this.db.refund.findMany({
      where: {
        OR: [
          {
            status: "REQUESTED",
            requestedAt: { lt: oneHourAgo },
            processingStartedAt: null,
          },
          {
            status: { in: ["REQUESTED", "PROCESSING"] },
            processingStartedAt: { lte: expiredRefundLeaseAt },
          },
          {
            status: "FAILED",
            requestedAt: { lt: oneDayAgo },
          },
        ],
      },
    });
    for (const refund of staleRefunds) {
      try {
        if (
          refund.processingStartedAt !== null &&
          now.getTime() - refund.processingStartedAt.getTime() <
            this.config.refundClaimLeaseSeconds * 1000
        ) {
          continue;
        }
        const age = now.getTime() - refund.requestedAt.getTime();
        if (refund.status === "FAILED" && age < ONE_DAY_MS) continue;

        if (refund.razorpayRefundId !== null) {
          const providerRefund = await this.gateway.fetchRefund(refund.razorpayRefundId);
          if (
            refund.status === "FAILED" &&
            providerRefund.status === "failed" &&
            age >= ONE_DAY_MS
          ) {
            await this.db.$transaction(async (tx) => {
              const retry = await tx.refund.updateMany({
                where: {
                  id: refund.id,
                  status: "FAILED",
                  attemptNumber: refund.attemptNumber,
                  razorpayRefundId: refund.razorpayRefundId,
                  requestedAt: refund.requestedAt,
                  processingStartedAt: null,
                },
                data: {
                  status: "REQUESTED",
                  razorpayRefundId: null,
                  requestedAt: now,
                  processingStartedAt: null,
                  attemptNumber: { increment: 1 },
                  failureReason: null,
                },
              });
              if (retry.count > 0) {
                await this.recordRefundExecutionOutbox(
                  tx,
                  refund.id,
                  refund.attemptNumber + 1,
                );
              }
            });
            continue;
          }
          await this.applyProviderRefundStatus(
            refund.id,
            refund.attemptNumber,
            providerRefund.providerRefundId,
            providerRefund.status,
          );
          continue;
        }

        await this.db.$transaction((tx) =>
          this.recordRefundExecutionOutbox(tx, refund.id, refund.attemptNumber),
        );
      } catch (error: unknown) {
        this.logger.error(
          { refundId: refund.id, paymentId: refund.paymentId, err: error },
          "REFUND_RECONCILE_FAILED",
        );
      }
    }

    const processedRefundsWithoutEvents = await this.db.$queryRaw<Array<{
      refundId: string;
      paymentId: string;
      purpose: PaymentPurpose;
      subjectId: string;
    }>>`
      SELECT r.id AS "refundId", p.id AS "paymentId", p.purpose::text AS purpose, p.subject_id AS "subjectId"
      FROM "refund" r
      JOIN "payment" p ON p.id = r.payment_id
      WHERE r.status = 'PROCESSED'
        AND NOT EXISTS (
          SELECT 1
          FROM "payment_outbox_job" o
          WHERE o.event_key = 'payments.refunded:' || p.id
        )
    `;
    for (const payment of processedRefundsWithoutEvents) {
      try {
        await this.recordOutboxJob(this.db, {
          eventKey: `payments.refunded:${payment.paymentId}`,
          jobName: `payments.refunded.${payment.purpose}`,
          payload: { paymentId: payment.paymentId, subjectId: payment.subjectId },
        });
      } catch (error: unknown) {
        this.logger.error(
          {
            paymentId: payment.paymentId,
            refundId: payment.refundId,
            eventKey: `payments.refunded:${payment.paymentId}`,
            err: error,
          },
          "PAYMENT_OUTBOX_RECOVERY_FAILED",
        );
      }
    }

    const pendingOutbox = await this.db.paymentOutboxJob.findMany({
      where: {
        dispatchedAt: null,
        OR: [
          { claimedAt: null },
          { claimedAt: { lte: expiredOutboxLeaseAt } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    for (const event of pendingOutbox) {
      try {
        await this.dispatchOutboxJob(event.eventKey);
      } catch (error: unknown) {
        const payload = isRecord(event.payload) ? event.payload : {};
        this.logger.error(
          {
            eventKey: event.eventKey,
            jobName: event.jobName,
            paymentId: readString(payload.paymentId),
            refundId: readString(payload.refundId),
            eventId: readString(payload.eventId),
            err: error,
          },
          "PAYMENT_OUTBOX_DISPATCH_FAILED",
        );
      }
    }
  }
}

// ---------- Provider response helpers ----------

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}


function withOrderId(
  provider: PaymentProviderPayment,
  orderId: string,
): PaymentProviderPayment | null {
  if (provider.orderId !== null && provider.orderId !== orderId) return null;
  if (provider.orderId === orderId) return provider;
  return { ...provider, orderId };
}
