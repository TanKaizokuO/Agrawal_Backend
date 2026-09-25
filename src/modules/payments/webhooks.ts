import { createHmac, timingSafeEqual } from "node:crypto";
import type { Clock } from "../../clock.js";
import type { PaymentGateway, PaymentProviderPayment } from "../../adapters/ports.js";
import { jsonInputValue } from "../../adapters/prisma-json.js";
import type { JobRuntime } from "../../jobs.js";
import { isRecord, isUniqueViolation } from "./guards.js";
import { PAYMENT_JOB_RETRY_OPTIONS } from "./jobs.js";
import type { PaymentDatabase } from "./db.js";

type RefundStatus = "processed" | "failed";

export interface PaymentWebhookEffects {
  readonly applyCapture: (payment: PaymentProviderPayment) => Promise<void>;
  readonly applyFailure: (payment: PaymentProviderPayment) => Promise<void>;
  readonly applyRefundStatus: (input: {
    readonly refundId: string;
    readonly attemptNumber: number;
    readonly providerRefundId: string;
    readonly status: RefundStatus;
    readonly failureReason?: string | null;
  }) => Promise<void>;
}

export interface PaymentWebhookLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface PaymentWebhookServiceDeps {
  readonly db: PaymentDatabase;
  readonly gateway: PaymentGateway;
  readonly jobs: JobRuntime;
  readonly clock: Clock;
  readonly secret: string;
  readonly effects: PaymentWebhookEffects;
  readonly logger?: PaymentWebhookLogger;
}

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

interface WebhookRefundEntity {
  readonly id: string;
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

export class PaymentWebhookService {
  private readonly db: PaymentDatabase;
  private readonly gateway: PaymentGateway;
  private readonly jobs: JobRuntime;
  private readonly clock: Clock;
  private readonly secret: string;
  private readonly effects: PaymentWebhookEffects;
  private readonly logger: PaymentWebhookLogger;

  constructor(deps: PaymentWebhookServiceDeps) {
    this.db = deps.db;
    this.gateway = deps.gateway;
    this.jobs = deps.jobs;
    this.clock = deps.clock;
    this.secret = deps.secret;
    this.effects = deps.effects;
    this.logger = deps.logger ?? {
      warn: (_bindings, message) => { console.warn(message); },
    };
  }

  /**
   * Return false for invalid requests; persistence/enqueue failures reject so the sender can retry.
   */
  async receive(rawBody: Buffer, signatureHex: string, eventId: string): Promise<boolean> {
    if (!verifyWebhookSignature(rawBody, signatureHex, this.secret)) {
      this.logger.warn({}, "invalid webhook signature");
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return false;
    }
    if (!isRecord(parsed)) return false;

    const eventType = typeof parsed.event === "string" ? parsed.event : "";
    if (eventId.trim().length === 0 || eventType.trim().length === 0) return false;
    await this.ingestWebhookEvent(eventId, eventType, parsed);
    return true;
  }

  private async ingestWebhookEvent(eventId: string, eventType: string, payload: unknown): Promise<void> {
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
            payload: payloadValue,
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
      await this.jobs.send("payments.applyWebhook", { eventId }, PAYMENT_JOB_RETRY_OPTIONS);
    }
  }

  /** Mark the durable event processed only after its state effects succeed. */
  async applyWebhook(eventId: string): Promise<void> {
    const event = await this.db.webhookEvent.findUnique({ where: { eventId } });
    if (event === null || event.processedAt !== null) return;

    const payload = isRecord(event.payload) ? event.payload : null;
    const nestedPayload = isRecord(payload?.payload) ? payload.payload : null;
    const eventPayload = nestedPayload ?? payload ?? {};

    switch (event.event) {
      case "payment.captured": {
        const payment = extractPaymentFromWebhook(eventPayload);
        if (payment !== null) await this.effects.applyCapture(payment);
        break;
      }
      case "order.paid":
        await this.applyOrderPaid(eventPayload);
        break;
      case "payment.failed": {
        const payment = extractPaymentFromWebhook(eventPayload);
        if (payment !== null) await this.effects.applyFailure(payment);
        break;
      }
      case "refund.processed": {
        const refund = extractRefundFromWebhook(eventPayload);
        if (refund !== null) await this.applyRefundStatus(refund, "processed");
        break;
      }
      case "refund.failed": {
        const refund = extractRefundFromWebhook(eventPayload);
        if (refund !== null) await this.applyRefundStatus(refund, "failed");
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
      if (provider !== null) await this.effects.applyCapture(provider);
      return;
    }

    const providerPaymentId = readString(order?.payment_id);
    if (providerPaymentId !== null) {
      const provider = withOrderId(await this.gateway.fetchPayment(providerPaymentId), orderId);
      if (provider !== null) await this.effects.applyCapture(provider);
      return;
    }

    const orderPayments = await this.gateway.fetchOrderPayments(orderId);
    const captured = orderPayments.find((candidate) => candidate.status === "captured");
    if (captured !== undefined) {
      const provider = withOrderId(captured, orderId);
      if (provider !== null) await this.effects.applyCapture(provider);
    }
  }

  private async applyRefundStatus(
    refund: WebhookRefundEntity,
    status: RefundStatus,
  ): Promise<void> {
    const attempt = await this.db.refundAttempt.findUnique({
      where: { razorpayRefundId: refund.id },
    });
    if (attempt === null) return;
    await this.effects.applyRefundStatus({
      refundId: attempt.refundId,
      attemptNumber: attempt.attemptNumber,
      providerRefundId: refund.id,
      status,
      ...(status === "failed" ? { failureReason: refund.errorDescription } : {}),
    });
  }
}
