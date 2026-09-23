import { createHmac, timingSafeEqual } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { Prisma } from "../../generated/prisma/client.js";
import type { Clock } from "../../clock.js";
import type { PaymentGateway, PaymentProviderPayment } from "../../adapters/ports.js";
import type { JobRuntime } from "../../jobs.js";
import { AppError } from "../../http/errors.js";
import { isRecord } from "./guards.js";
import { paymentCapturedJobName, type PaymentCapturedPayload } from "./events.js";
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
  readonly razorpayWebhookSecret: string;
  readonly paymentIdentityHmacKey: string;
}

function jsonInputValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonInputValue(item));
  if (isRecord(value)) {
    const object: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value)) {
      object[key] = jsonInputValue(item);
    }
    return object;
  }
  throw new AppError("VALIDATION_FAILED", 400);
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

export function verifyWebhookSignature(
  rawBody: Uint8Array,
  signatureHex: string,
  secret: string,
): boolean {
  if (!/^[0-9a-f]{64}$/iu.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signatureHex, "hex");
  return timingSafeEqual(expected, received);
}

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
const JOB_RETRY_OPTIONS = { retryLimit: 5, retryBackoff: true } as const;

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

    return this.db.$transaction(async (tx) => {
      // A subject can have at most one active checkout at a time. The advisory
      // lock also closes the read-then-create race when two HTTP retries arrive
      // on different workers before either Payment row is visible.
      const lockKey = `payment-order:${input.purpose}:${input.subjectId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const captured = await tx.payment.findFirst({
        where: {
          purpose: input.purpose,
          subjectId: input.subjectId,
          status: { in: ["CAPTURED", "REFUND_PENDING"] },
        },
      });
      if (captured !== null) return this.checkoutOrder(captured, input.payerPhoneE164, true);

      const cutoff = new Date(this.clock.now().getTime() - THIRTY_MINUTES_MS);
      const recent = await tx.payment.findFirst({
        where: {
          purpose: input.purpose,
          subjectId: input.subjectId,
          status: "CREATED",
          createdAt: { gte: cutoff },
        },
        orderBy: { createdAt: "desc" },
      });
      if (recent !== null) return this.checkoutOrder(recent, input.payerPhoneE164, false);

      const paymentId = uuidv7();
      const providerOrder = await this.gateway.createOrder({
        amountPaise: input.amountPaise,
        currency: "INR",
        receipt: paymentId,
        notes: { purpose: input.purpose, subjectId: input.subjectId },
      });
      if (
        providerOrder.providerOrderId.length === 0
        || !Number.isSafeInteger(providerOrder.amountPaise)
        || providerOrder.amountPaise <= 0
      ) {
        throw new AppError("UPSTREAM_UNAVAILABLE", 503);
      }

      const payment = await tx.payment.create({
        data: {
          id: paymentId,
          purpose: input.purpose,
          subjectId: input.subjectId,
          payerPhoneE164: input.payerPhoneE164,
          payerMemberId: input.payerMemberId ?? null,
          amountPaise: providerOrder.amountPaise,
          currency: "INR",
          status: "CREATED",
          razorpayOrderId: providerOrder.providerOrderId,
        },
      });
      return this.checkoutOrder(payment, input.payerPhoneE164, false);
    });
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

  // ---- Webhook ingestion ----

  verifyWebhook(rawBody: Uint8Array, signatureHex: string): boolean {
    return verifyWebhookSignature(rawBody, signatureHex, this.config.razorpayWebhookSecret);
  }

  async ingestWebhookEvent(eventId: string, eventType: string, payload: unknown): Promise<void> {
    if (eventId.trim().length === 0 || eventType.trim().length === 0) {
      throw new AppError("VALIDATION_FAILED", 400);
    }
    const payloadValue = jsonInputValue(payload);

    let shouldEnqueue = false;
    try {
      await this.db.$transaction(async (tx) => {
        const existing = await tx.webhookEvent.findUnique({ where: { eventId } });
        if (existing !== null) {
          shouldEnqueue = existing.processedAt === null;
          return;
        }
        await tx.webhookEvent.create({
          data: {
            eventId,
            event: eventType,
            payload: payloadValue === null ? Prisma.JsonNull : payloadValue,
          },
        });
        shouldEnqueue = true;
      });
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.webhookEvent.findUnique({ where: { eventId } });
      shouldEnqueue = existing?.processedAt === null;
    }

    if (shouldEnqueue) {
      await this.jobs.send("payments.applyWebhook", { eventId }, JOB_RETRY_OPTIONS);
    }
  }

  async applyWebhook(eventId: string): Promise<void> {
    const event = await this.db.webhookEvent.findUnique({ where: { eventId } });
    if (event === null || event.processedAt !== null) return;

    const payload = isRecord(event.payload) ? event.payload : null;
    const nestedPayload = isRecord(payload?.payload) ? payload.payload : null;
    const eventPayload = nestedPayload ?? payload ?? {};

    switch (event.event) {
      case "payment.captured": {
        const payment = extractPaymentFromWebhook(eventPayload);
        if (payment !== null) await this.applyCapture(payment);
        break;
      }
      case "order.paid":
        await this.applyOrderPaid(eventPayload);
        break;
      case "payment.failed": {
        const payment = extractPaymentFromWebhook(eventPayload);
        if (payment !== null) await this.applyFailure(payment);
        break;
      }
      case "refund.processed": {
        const refund = extractRefundFromWebhook(eventPayload);
        if (refund !== null) await this.applyRefundProcessed(refund);
        break;
      }
      case "refund.failed": {
        const refund = extractRefundFromWebhook(eventPayload);
        if (refund !== null) await this.applyRefundFailed(refund);
        break;
      }
      default:
        break;
    }

    await this.db.webhookEvent.update({
      where: { eventId },
      data: { processedAt: this.clock.now() },
    });
  }

  private async applyOrderPaid(eventPayload: Record<string, unknown>): Promise<void> {
    const orderWrapper = isRecord(eventPayload.order) ? eventPayload.order : null;
    const order = isRecord(orderWrapper?.entity) ? orderWrapper.entity : orderWrapper;
    const orderId = readString(order?.id);
    if (orderId === null) return;

    const paymentEntity = extractPaymentFromWebhook(eventPayload);
    if (paymentEntity !== null) {
      const provider = withOrderId(paymentEntity, orderId);
      if (provider !== null) await this.applyCapture(provider);
      return;
    }

    const providerPaymentId = readString(order?.payment_id);
    if (providerPaymentId !== null) {
      const provider = withOrderId(await this.gateway.fetchPayment(providerPaymentId), orderId);
      if (provider !== null) await this.applyCapture(provider);
      return;
    }

    const orderPayments = await this.gateway.fetchOrderPayments(orderId);
    const captured = orderPayments.find((candidate) => candidate.status === "captured");
    if (captured !== undefined) {
      const provider = withOrderId(captured, orderId);
      if (provider !== null) await this.applyCapture(provider);
    }
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

  private async applyCapture(provider: PaymentProviderPayment): Promise<void> {
    if (provider.orderId === null || provider.id.length === 0) return;

    const payment = await this.db.payment.findUnique({
      where: { razorpayOrderId: provider.orderId },
    });
    if (payment === null) return;
    if (
      provider.amountPaise !== null &&
      provider.amountPaise !== payment.amountPaise
    ) {
      this.logger.warn(
        { paymentId: payment.id, providerPaymentId: provider.id },
        "PAYMENT_AMOUNT_MISMATCH",
      );
      return;
    }
    if (
      payment.razorpayPaymentId !== null &&
      payment.razorpayPaymentId !== provider.id
    ) {
      return;
    }

    const identity = extractIdentity(provider, this.config.paymentIdentityHmacKey);
    const changed = await this.db.payment.updateMany({
      where: {
        id: payment.id,
        status: { in: ["CREATED", "FAILED"] },
      },
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
    if (changed.count === 0) return;

    const captured: PaymentCapturedPayload = { paymentId: payment.id, subjectId: payment.subjectId };
    await this.jobs.send(
      paymentCapturedJobName(payment.purpose),
      captured,
      JOB_RETRY_OPTIONS,
    );
  }

  private async applyFailure(provider: PaymentProviderPayment): Promise<void> {
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

  private async applyRefundProcessed(refundEntity: WebhookRefundEntity): Promise<void> {
    let refund = await this.db.refund.findFirst({
      where: { razorpayRefundId: refundEntity.id },
    });
    if (refund === null && refundEntity.paymentId !== "") {
      refund = await this.db.refund.findUnique({
        where: { paymentId: refundEntity.paymentId },
      });
    }
    if (refund === null) return;

    const changed = await this.db.refund.updateMany({
      where: { id: refund.id, status: { in: ["REQUESTED", "FAILED"] } },
      data: {
        status: "PROCESSED",
        processedAt: this.clock.now(),
        failureReason: null,
        razorpayRefundId: refund.razorpayRefundId ?? refundEntity.id,
      },
    });
    if (changed.count === 0) return;

    const payment = await this.db.payment.findUnique({ where: { id: refund.paymentId } });
    if (payment === null) return;
    const paymentChanged = await this.db.payment.updateMany({
      where: { id: payment.id, status: { not: "REFUNDED" } },
      data: { status: "REFUNDED" },
    });
    if (paymentChanged.count === 0) return;

    await this.jobs.send(
      `payments.refunded.${payment.purpose}`,
      { paymentId: payment.id, subjectId: payment.subjectId },
      JOB_RETRY_OPTIONS,
    );
  }

  private async applyRefundFailed(refundEntity: WebhookRefundEntity): Promise<void> {
    let refund = await this.db.refund.findFirst({
      where: { razorpayRefundId: refundEntity.id },
    });
    if (refund === null && refundEntity.paymentId !== "") {
      refund = await this.db.refund.findUnique({
        where: { paymentId: refundEntity.paymentId },
      });
    }
    if (refund === null || refund.status === "PROCESSED") return;

    await this.db.refund.update({
      where: { id: refund.id },
      data: {
        status: "FAILED",
        requestedAt: this.clock.now(),
        failureReason: refundEntity.errorDescription ?? "refund_failed",
        razorpayRefundId: refund.razorpayRefundId ?? refundEntity.id,
      },
    });
    this.logger.error(
      { refundId: refund.id, paymentId: refund.paymentId },
      "REFUND_FAILED",
    );
  }

  // ---- Refunds ----

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

    await this.jobs.send("payments.executeRefund", { refundId }, JOB_RETRY_OPTIONS);
  }

  async executeRefund(refundId: string): Promise<void> {
    let gatewayFailure: { readonly error: unknown } | undefined;

    await this.db.$transaction(async (tx) => {
      const lockKey = `payment-refund:${refundId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const refund = await tx.refund.findUnique({ where: { id: refundId } });
      if (
        refund === null ||
        refund.status === "PROCESSED" ||
        (refund.razorpayRefundId !== null && refund.status !== "FAILED")
      ) {
        return;
      }
      const payment = await tx.payment.findUnique({ where: { id: refund.paymentId } });
      if (payment === null || payment.razorpayPaymentId === null) return;

      try {
        const result = await this.gateway.refund({
          providerPaymentId: payment.razorpayPaymentId,
          amountPaise: refund.amountPaise,
          speed: "normal",
          notes: { reason: refund.reason },
        });
        await tx.refund.update({
          where: { id: refund.id },
          data: { razorpayRefundId: result.providerRefundId, requestedAt: this.clock.now() },
        });
      } catch (error: unknown) {
        gatewayFailure = { error };
        await tx.refund.update({
          where: { id: refund.id },
          data: {
            status: "FAILED",
            requestedAt: this.clock.now(),
            failureReason: error instanceof Error ? error.message : "refund_failed",
          },
        });
      }
    });

    if (gatewayFailure !== undefined) {
      throw gatewayFailure.error instanceof Error ? gatewayFailure.error : new Error("refund_failed");
    }
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
    const fortyEightHoursAgo = new Date(now.getTime() - FORTY_EIGHT_HOURS_MS);

    const staleCreated = await this.db.payment.findMany({
      where: {
        status: "CREATED",
        createdAt: { gte: fortyEightHoursAgo, lte: fiveMinAgo },
      },
    });
    for (const payment of staleCreated) {
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
    }

    const abandoned = await this.db.payment.findMany({
      where: { status: "CREATED", createdAt: { lt: fortyEightHoursAgo } },
    });
    for (const payment of abandoned) {
      await this.db.payment.updateMany({
        where: { id: payment.id, status: "CREATED" },
        data: {
          status: "FAILED",
          failedAt: now,
          failureReason: "ORDER_ABANDONED",
        },
      });
    }

    const oneHourAgo = new Date(now.getTime() - ONE_HOUR_MS);
    const staleRefunds = await this.db.refund.findMany({
      where: {
        OR: [
          { status: "REQUESTED", razorpayRefundId: null, requestedAt: { lt: oneHourAgo } },
          { status: "FAILED" },
        ],
      },
    });
    for (const refund of staleRefunds) {
      const age = now.getTime() - refund.requestedAt.getTime();
      if (refund.status === "FAILED" && age < ONE_DAY_MS) continue;

      const claimed = await this.db.refund.updateMany({
        where:
          refund.status === "FAILED"
            ? { id: refund.id, status: "FAILED", requestedAt: refund.requestedAt }
            : {
                id: refund.id,
                status: "REQUESTED",
                razorpayRefundId: null,
                requestedAt: refund.requestedAt,
              },
        data: { requestedAt: now },
      });
      if (claimed.count === 0) continue;
      await this.jobs.send("payments.executeRefund", { refundId: refund.id }, JOB_RETRY_OPTIONS);
    }
  }
}

// ---------- Webhook payload helpers ----------

interface WebhookRefundEntity {
  readonly id: string;
  readonly paymentId: string;
  readonly errorDescription: string | null;
}


function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : null;
}

function extractPaymentFromWebhook(
  eventPayload: Record<string, unknown>,
): PaymentProviderPayment | null {
  const paymentWrapper = isRecord(eventPayload.payment) ? eventPayload.payment : null;
  const entity = isRecord(paymentWrapper?.entity) ? paymentWrapper.entity : paymentWrapper;
  if (entity === null) return null;
  const id = readString(entity.id);
  if (id === null) return null;
  const status = readString(entity.status) ?? "unknown";
  const card = isRecord(entity.card) ? entity.card : null;
  return {
    id,
    orderId: readString(entity.order_id),
    status,
    amountPaise: readNumber(entity.amount),
    method: readString(entity.method),
    vpa: readString(entity.vpa),
    cardId: readString(entity.card_id),
    cardLast4: readString(card?.last4),
    errorDescription: readString(entity.error_description),
  };
}

function extractRefundFromWebhook(
  eventPayload: Record<string, unknown>,
): WebhookRefundEntity | null {
  const refundWrapper = isRecord(eventPayload.refund) ? eventPayload.refund : null;
  const entity = isRecord(refundWrapper?.entity) ? refundWrapper.entity : refundWrapper;
  if (entity === null) return null;
  const id = readString(entity.id);
  if (id === null) return null;
  return {
    id,
    paymentId: readString(entity.payment_id) ?? "",
    errorDescription: readString(entity.error_description),
  };
}

function withOrderId(
  provider: PaymentProviderPayment,
  orderId: string,
): PaymentProviderPayment | null {
  if (provider.orderId !== null && provider.orderId !== orderId) return null;
  if (provider.orderId === orderId) return provider;
  return { ...provider, orderId };
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("code" in error)) return undefined;
  return error.code;
}

function isUniqueViolation(error: unknown): boolean {
  const code = errorCode(error);
  return code === "P2002" || code === "23505";
}

function isNotFoundViolation(error: unknown): boolean {
  const code = errorCode(error);
  return code === "P2025" || code === "02000";
}
