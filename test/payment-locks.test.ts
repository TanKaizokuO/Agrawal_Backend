import { createHmac } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import type { PaymentGateway, PaymentProviderPayment, PaymentRefund } from "../src/adapters/ports.js";
import { FixedClock } from "../src/clock.js";
import type { JobRuntime, JobSendOptions } from "../src/jobs.js";
import { PaymentService, PaymentWebhookService } from "../src/modules/payments/index.js";
import { OfficerService } from "../src/modules/officer/index.js";
import { createProcessingRecordWriter } from "../src/adapters/processing-record.js";
import { getTestDatabase } from "./setup.js";

class FakeGateway implements PaymentGateway {
  orders = 0;
  refunds = 0;
  refundStatus: PaymentRefund["status"] = "pending";
  readonly orderPayments = new Map<string, readonly PaymentProviderPayment[]>();
  readonly ordersByReceipt = new Map<string, { providerOrderId: string; amountPaise: number; currency: "INR" }>();
  readonly refundStatuses = new Map<string, PaymentRefund>();
  lastRefundInput: Parameters<PaymentGateway["refund"]>[0] | null = null;
  readonly refundInputs: Array<Parameters<PaymentGateway["refund"]>[0]> = [];
  beforeCreateOrder: ((input: Parameters<PaymentGateway["createOrder"]>[0]) => Promise<void>) | undefined;
  beforeRefund: ((input: Parameters<PaymentGateway["refund"]>[0]) => Promise<void>) | undefined;
  afterCreateOrder: ((input: Parameters<PaymentGateway["createOrder"]>[0]) => Promise<void>) | undefined;
  fetchOrderPaymentsHandler:
    | ((orderId: string) => Promise<readonly PaymentProviderPayment[]>)
    | undefined;

  async createOrder(input: Parameters<PaymentGateway["createOrder"]>[0]) {
    this.orders += 1;
    await this.beforeCreateOrder?.(input);
    const order = {
      providerOrderId: `order_${uuidv7()}`,
      amountPaise: input.amountPaise,
      currency: "INR" as const,
    };
    this.ordersByReceipt.set(input.receipt, order);
    await this.afterCreateOrder?.(input);
    return order;
  }

  findOrderByReceipt(receipt: string) {
    return Promise.resolve(this.ordersByReceipt.get(receipt) ?? null);
  }

  fetchPayment(): Promise<PaymentProviderPayment> {
    throw new Error("not used");
  }

  fetchOrderPayments(orderId: string): Promise<readonly PaymentProviderPayment[]> {
    if (this.fetchOrderPaymentsHandler !== undefined) return this.fetchOrderPaymentsHandler(orderId);
    return Promise.resolve(this.orderPayments.get(orderId) ?? []);
  }

  capture(): Promise<PaymentProviderPayment> {
    throw new Error("not used");
  }

  async refund(input: Parameters<PaymentGateway["refund"]>[0]): Promise<PaymentRefund> {
    this.refunds += 1;
    this.lastRefundInput = input;
    this.refundInputs.push(input);
    await this.beforeRefund?.(input);
    return { providerRefundId: `rfnd_${uuidv7()}`, status: this.refundStatus };
  }

  fetchRefund(providerRefundId: string): Promise<PaymentRefund> {
    const refund = this.refundStatuses.get(providerRefundId);
    if (refund === undefined) throw new Error("refund not configured");
    return Promise.resolve(refund);
  }
}

class TestJobs implements JobRuntime {
  readonly attempts: Array<{ name: string; payload: unknown; options: JobSendOptions | undefined }> = [];
  readonly sent: Array<{ name: string; payload: unknown; options: JobSendOptions | undefined }> = [];
  onSend: ((name: string, payload: unknown, options?: JobSendOptions) => Promise<void>) | undefined;
  readonly enabled = false;

  async send(name: string, payload: unknown, options?: JobSendOptions): Promise<string> {
    const job = { name, payload, options };
    this.attempts.push(job);
    await this.onSend?.(name, payload, options);
    this.sent.push(job);
    return `job-${this.sent.length.toString()}`;
  }

  registerWorker(): Promise<void> { return Promise.resolve(); }
  start(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }
  isReady(): Promise<boolean> { return Promise.resolve(true); }
}

function createService(
  gateway: FakeGateway,
  jobs = new TestJobs(),
  clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z")),
  logger?: {
    warn(bindings: Record<string, unknown>, message: string): void;
    error(bindings: Record<string, unknown>, message: string): void;
  },
): PaymentService {
  return new PaymentService({
    db: getTestDatabase(),
    gateway,
    jobs,
    clock,
    config: {
      razorpayKeyId: "rzp_test_key",
      razorpayKeySecret: "secret",
      paymentIdentityHmacKey: "hmac-key",
      orderCreationClaimLeaseSeconds: 300,
      refundClaimLeaseSeconds: 3600,
      outboxClaimLeaseSeconds: 300,
      outboxJobDedupSeconds: 3600,
    },
    ...(logger === undefined ? {} : { logger }),
  });
}
function createWebhookService(
  service: PaymentService,
  gateway: FakeGateway,
  jobs: TestJobs,
  clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z")),
): PaymentWebhookService {
  return new PaymentWebhookService({
    db: getTestDatabase(),
    gateway,
    jobs,
    clock,
    secret: "webhook-secret",
    logger: { warn: () => undefined },
    effects: {
      applyCapture: (payment) => service.applyCapture(payment),
      applyFailure: (payment) => service.applyFailure(payment),
      applyRefundStatus: (input) => service.applyProviderRefundStatus(
        input.refundId,
        input.attemptNumber,
        input.providerRefundId,
        input.status,
        undefined,
        input.failureReason,
      ),
    },
  });
}

function providerPayment(
  orderId: string,
  status: PaymentProviderPayment["status"] = "captured",
): PaymentProviderPayment {
  return {
    id: `pay_${uuidv7()}`,
    orderId,
    status,
    amountPaise: 10_000,
    method: "upi",
    vpa: null,
    cardId: null,
    cardLast4: null,
    errorDescription: null,
  };
}

async function seedPayment(input: {
  readonly status?: "CREATED" | "CAPTURED" | "REFUND_PENDING" | "REFUNDED";
  readonly createdAt?: Date;
  readonly consumedAt?: Date | null;
  readonly razorpayRefundId?: string | null;
} = {}) {
  const database = getTestDatabase();
  const paymentId = uuidv7();
  const payment = await database.payment.create({
    data: {
      id: paymentId,
      purpose: "REGISTRATION",
      subjectId: uuidv7(),
      payerPhoneE164: "+919876543210",
      amountPaise: 10_000,
      status: input.status ?? "CAPTURED",
      razorpayOrderId: `order_${uuidv7()}`,
      razorpayPaymentId: input.status === "CREATED" ? null : `pay_${uuidv7()}`,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.consumedAt === undefined ? {} : { consumedAt: input.consumedAt }),
    },
  });
  const refund = input.razorpayRefundId === undefined ? null : await database.refund.create({
    data: {
      id: uuidv7(),
      paymentId: payment.id,
      reason: "REGISTRATION_ABANDONED",
      amountPaise: payment.amountPaise,
      status: "REQUESTED",
      razorpayRefundId: input.razorpayRefundId,
      requestedAt: new Date("2026-09-22T02:00:00.000Z"),
    },
  });
  if (refund !== null && typeof input.razorpayRefundId === "string") {
    await database.refundAttempt.create({
      data: {
        refundId: refund.id,
        attemptNumber: 0,
        razorpayRefundId: input.razorpayRefundId,
      },
    });
  }
  return { payment, refund };
}
function requireRefund(refund: { readonly id: string } | null): { readonly id: string } {
  if (refund === null) throw new Error("Expected a refund in this test fixture");
  return refund;
}

describe("Payment reliability", () => {
  it("coalesces local callers and uses PaymentOrderClaim across service instances", async () => {
    const database = getTestDatabase();
    const clock = new FixedClock(new Date());
    const gateway = new FakeGateway();
    const firstService = createService(gateway, new TestJobs(), clock);
    const retryingService = createService(gateway, new TestJobs(), clock);
    const order = {
      purpose: "REGISTRATION" as const,
      subjectId: uuidv7(),
      payerPhoneE164: "+919876543210",
      amountPaise: 10_000,
    };
    let signalStarted: () => void = () => {};
    let releaseGateway: () => void = () => {};
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseGateway = resolve; });
    gateway.beforeCreateOrder = async () => {
      const claim = await database.paymentOrderClaim.findUnique({
        where: {
          purpose_subjectId: {
            purpose: order.purpose,
            subjectId: order.subjectId,
          },
        },
      });
      expect(claim).not.toBeNull();
      signalStarted();
      await blocked;
    };

    const creating = firstService.createOrder(order);
    await started;
    const sameProcess = firstService.createOrder(order);
    await expect(retryingService.createOrder(order)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    releaseGateway();
    const [first, localRetry] = await Promise.all([creating, sameProcess]);
    const retry = await retryingService.createOrder(order);

    expect(retry.paymentId).toBe(first.paymentId);
    expect(localRetry.paymentId).toBe(first.paymentId);
    expect(localRetry.razorpayOrderId).toBe(first.razorpayOrderId);
    expect(retry.razorpayOrderId).toBe(first.razorpayOrderId);
    expect(gateway.orders).toBe(1);
    expect(await database.paymentOrderClaim.findUnique({
      where: {
        purpose_subjectId: {
          purpose: order.purpose,
          subjectId: order.subjectId,
        },
      },
    })).toBeNull();
    expect(await database.payment.findUnique({ where: { id: first.paymentId } })).not.toBeNull();
  });

  it("recovers a provider-created order by its stable receipt after an unknown response", async () => {
    const clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z"));
    const gateway = new FakeGateway();
    const service = createService(gateway, new TestJobs(), clock);
    const order = {
      purpose: "REGISTRATION" as const,
      subjectId: uuidv7(),
      payerPhoneE164: "+919876543210",
      amountPaise: 10_000,
    };
    gateway.afterCreateOrder = () => Promise.reject(new Error("response lost after provider creation"));

    await expect(service.createOrder(order)).rejects.toThrow("response lost");
    clock.advance(6 * 60 * 1000);
    const recovered = await service.createOrder(order);

    expect(gateway.orders).toBe(1);
    expect(recovered.paymentId).toBe([...gateway.ordersByReceipt.keys()][0]);
  });


  it("atomically claims a refund and sends its stable gateway idempotency key", async () => {
    const database = getTestDatabase();
    const gateway = new FakeGateway();
    const service = createService(gateway);
    const { payment } = await seedPayment();
    await database.$transaction((tx) => service.refund(
      tx,
      payment.id,
      "REGISTRATION_ABANDONED",
      { kind: "SYSTEM" },
    ));
    const refund = await database.refund.findUniqueOrThrow({ where: { paymentId: payment.id } });

    let signalStarted: () => void = () => {};
    let releaseGateway: () => void = () => {};
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseGateway = resolve; });
    gateway.beforeRefund = async () => {
      const claimed = await database.refund.findUniqueOrThrow({ where: { id: refund.id } });
      expect(claimed.status).toBe("PROCESSING");
      signalStarted();
      await blocked;
    };

    const first = service.executeRefund(refund.id);
    await started;
    await service.executeRefund(refund.id);
    releaseGateway();
    await first;

    expect(gateway.refunds).toBe(1);
    expect(gateway.lastRefundInput?.idempotencyKey).toBe(refund.id);
    expect((await database.refund.findUniqueOrThrow({ where: { id: refund.id } })).razorpayRefundId).toMatch(/^rfnd_/u);
  });
  it("persists refund execution to the outbox in the caller transaction", async () => {
    const database = getTestDatabase();
    const gateway = new FakeGateway();
    const jobs = new TestJobs();
    const service = createService(gateway, jobs);
    const { payment } = await seedPayment();

    await expect(database.$transaction(async (tx) => {
      await service.refund(tx, payment.id, "REGISTRATION_ABANDONED", { kind: "SYSTEM" });
      expect(jobs.attempts).toHaveLength(0);
      throw new Error("rollback refund transaction");
    })).rejects.toThrow("rollback refund transaction");
    expect(await database.refund.findUnique({ where: { paymentId: payment.id } })).toBeNull();
    expect(await database.paymentOutboxJob.findMany({
      where: { jobName: "payments.executeRefund" },
    })).toHaveLength(0);
    expect(gateway.refunds).toBe(0);
    expect(jobs.attempts).toHaveLength(0);

    await database.$transaction((tx) =>
      service.refund(tx, payment.id, "REGISTRATION_ABANDONED", { kind: "SYSTEM" }),
    );
    const refund = await database.refund.findUniqueOrThrow({ where: { paymentId: payment.id } });
    const outbox = await database.paymentOutboxJob.findUniqueOrThrow({
      where: { eventKey: `payments.executeRefund:${refund.id}:0` },
    });
    expect(outbox.dispatchedAt).toBeNull();
    expect(gateway.refunds).toBe(0);
    expect(jobs.attempts).toHaveLength(0);
  });

  it("reclaims an expired refund lease with the attempt's existing idempotency key", async () => {
    const database = getTestDatabase();
    const gateway = new FakeGateway();
    const service = createService(gateway);
    const { payment } = await seedPayment();
    const refund = await database.refund.create({
      data: {
        id: uuidv7(),
        paymentId: payment.id,
        reason: "REGISTRATION_ABANDONED",
        amountPaise: payment.amountPaise,
        status: "PROCESSING",
        requestedAt: new Date("2026-09-22T02:00:00.000Z"),
        processingStartedAt: new Date("2026-09-22T02:00:00.000Z"),
      },
    });

    await service.executeRefund(refund.id);

    const finished = await database.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(gateway.lastRefundInput?.idempotencyKey).toBe(refund.id);
    expect(finished.status).toBe("REQUESTED");
    expect(finished.processingStartedAt).toBeNull();
    expect(finished.razorpayRefundId).not.toBeNull();
  });

  it("recovers a captured-payment follow-up after its first enqueue fails", async () => {
    const clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z"));
    const database = getTestDatabase();
    const gateway = new FakeGateway();
    const jobs = new TestJobs();
    let rejectCaptureJobs = true;
    const service = createService(gateway, jobs, clock);
    const { payment } = await seedPayment({
      status: "CREATED",
      createdAt: new Date(clock.now().getTime() - 60 * 60 * 1000),
    });
    jobs.onSend = async (name) => {
      if (name !== "payments.captured.REGISTRATION") return;
      expect((await database.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("CAPTURED");
      expect((await database.paymentOutboxJob.findUnique({
        where: { eventKey: `payments.captured:${payment.id}` },
      }))).not.toBeNull();
      if (rejectCaptureJobs) throw new Error("queue unavailable");
    };
    gateway.orderPayments.set(payment.razorpayOrderId, [providerPayment(payment.razorpayOrderId)]);

    await service.reconcile();
    rejectCaptureJobs = false;
    await service.reconcile();

    const outbox = await database.paymentOutboxJob.findUniqueOrThrow({
      where: { eventKey: `payments.captured:${payment.id}` },
    });
    expect((await database.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("CAPTURED");
    expect(outbox.dispatchedAt).not.toBeNull();
    expect(jobs.sent.filter((job) => job.name === "payments.captured.REGISTRATION")).toHaveLength(1);
  });

  it("isolates a Razorpay order failure and still reconciles other payment and refund items", async () => {
    const clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z"));
    const database = getTestDatabase();
    const gateway = new FakeGateway();
    const jobs = new TestJobs();
    const reconciliationErrors: Array<{
      bindings: Record<string, unknown>;
      message: string;
    }> = [];
    const orderFailure = new Error("deleted provider order");
    const service = createService(gateway, jobs, clock, {
      warn: () => undefined,
      error: (bindings, message) => {
        reconciliationErrors.push({ bindings, message });
      },
    });
    const staleAt = new Date(clock.now().getTime() - 60 * 60 * 1000);
    const failedOrder = await seedPayment({ status: "CREATED", createdAt: staleAt });
    const capturedOrder = await seedPayment({ status: "CREATED", createdAt: staleAt });
    const abandonedOrder = await seedPayment({
      status: "CREATED",
      createdAt: new Date(clock.now().getTime() - 49 * 60 * 60 * 1000),
    });
    const providerRefundId = `rfnd_${uuidv7()}`;
    const refundPayment = await seedPayment({
      status: "REFUND_PENDING",
      consumedAt: clock.now(),
      razorpayRefundId: providerRefundId,
    });
    const refundRecord = requireRefund(refundPayment.refund);
    gateway.fetchOrderPaymentsHandler = (orderId) => {
      if (orderId === failedOrder.payment.razorpayOrderId) {
        return Promise.reject(orderFailure);
      }
      return Promise.resolve([providerPayment(orderId)]);
    };
    gateway.refundStatuses.set(providerRefundId, { providerRefundId, status: "processed" });

    await service.reconcile();

    expect((await database.payment.findUniqueOrThrow({ where: { id: failedOrder.payment.id } })).status).toBe("CREATED");
    expect((await database.payment.findUniqueOrThrow({ where: { id: capturedOrder.payment.id } })).status).toBe("CAPTURED");
    expect((await database.payment.findUniqueOrThrow({ where: { id: abandonedOrder.payment.id } })).failureReason).toBe("ORDER_ABANDONED");
    expect((await database.refund.findUniqueOrThrow({ where: { id: refundRecord.id } })).status).toBe("PROCESSED");
    expect(jobs.sent.some((job) => job.name === "payments.refunded.REGISTRATION")).toBe(true);
    const paymentFailureLog = reconciliationErrors.find((entry) =>
      entry.message === "PAYMENT_RECONCILE_FAILED" &&
      entry.bindings.paymentId === failedOrder.payment.id
    );
    expect(paymentFailureLog?.bindings.err).toBe(orderFailure);
  });

  it("verifies raw webhook bytes before durable ingestion and applies capture through the outbox", async () => {
    const database = getTestDatabase();
    const clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z"));
    const gateway = new FakeGateway();
    const jobs = new TestJobs();
    const service = createService(gateway, jobs, clock);
    const webhookService = createWebhookService(service, gateway, jobs, clock);
    const { payment } = await seedPayment({ status: "CREATED" });
    const provider = providerPayment(payment.razorpayOrderId);
    const rawBody = Buffer.from(JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: provider.id,
            order_id: provider.orderId,
            status: provider.status,
            amount: provider.amountPaise,
            method: provider.method,
          },
        },
      },
    }));
    const eventId = uuidv7();

    expect(await webhookService.receive(rawBody, "invalid", eventId)).toBe(false);
    expect(await database.webhookEvent.findUnique({ where: { eventId } })).toBeNull();

    const signature = createHmac("sha256", "webhook-secret").update(rawBody).digest("hex");
    expect(await webhookService.receive(rawBody, signature, eventId)).toBe(true);
    await webhookService.applyWebhook(eventId);

    expect((await database.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("CAPTURED");
    expect(await database.paymentOutboxJob.findUnique({
      where: { eventKey: `payments.captured:${payment.id}` },
    })).not.toBeNull();
    expect((await database.webhookEvent.findUniqueOrThrow({ where: { eventId } })).processedAt).toEqual(clock.now());

    expect(await webhookService.receive(rawBody, signature, eventId)).toBe(true);
    expect(jobs.sent.filter((job) => job.name === "payments.applyWebhook")).toHaveLength(1);
  });

  it("dispatches payments.refunded when a processed-refund webhook is applied", async () => {
    const database = getTestDatabase();
    const gateway = new FakeGateway();
    const jobs = new TestJobs();
    const service = createService(gateway, jobs);
    const providerRefundId = `rfnd_${uuidv7()}`;
    const { payment, refund } = await seedPayment({
      status: "REFUND_PENDING",
      consumedAt: new Date("2026-09-22T03:00:00.000Z"),
      razorpayRefundId: providerRefundId,
    });
    const seededRefund = requireRefund(refund);
    jobs.onSend = async (name) => {
      if (name !== "payments.refunded.REGISTRATION") return;
      expect((await database.refund.findUniqueOrThrow({ where: { paymentId: payment.id } })).status).toBe("PROCESSED");
      expect((await database.paymentOutboxJob.findUnique({
        where: { eventKey: `payments.refunded:${payment.id}` },
      }))).not.toBeNull();
    };
    const eventId = uuidv7();
    await database.webhookEvent.create({
      data: {
        eventId,
        event: "refund.processed",
        payload: { refund: { entity: { id: providerRefundId, payment_id: payment.id } } },
      },
    });

    await createWebhookService(service, gateway, jobs).applyWebhook(eventId);

    expect((await database.refund.findUniqueOrThrow({ where: { id: seededRefund.id } })).status).toBe("PROCESSED");
    expect((await database.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("REFUNDED");
    expect(jobs.sent).toContainEqual(expect.objectContaining({
      name: "payments.refunded.REGISTRATION",
      payload: { paymentId: payment.id, subjectId: payment.subjectId },
    }));
  });

  it("converges provider-created refunds from authoritative provider states", async () => {
    const clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z"));
    const database = getTestDatabase();
    const gateway = new FakeGateway();
    const jobs = new TestJobs();
    const service = createService(gateway, jobs, clock);
    const processedId = `rfnd_${uuidv7()}`;
    const failedId = `rfnd_${uuidv7()}`;
    const pendingId = `rfnd_${uuidv7()}`;
    const processed = await seedPayment({ status: "REFUND_PENDING", consumedAt: clock.now(), razorpayRefundId: processedId });
    const failed = await seedPayment({ status: "REFUND_PENDING", consumedAt: clock.now(), razorpayRefundId: failedId });
    const pending = await seedPayment({ status: "REFUND_PENDING", consumedAt: clock.now(), razorpayRefundId: pendingId });
    const processedRefund = requireRefund(processed.refund);
    const failedRefund = requireRefund(failed.refund);
    const pendingRefund = requireRefund(pending.refund);
    gateway.refundStatuses.set(processedId, { providerRefundId: processedId, status: "processed" });
    gateway.refundStatuses.set(failedId, { providerRefundId: failedId, status: "failed" });
    gateway.refundStatuses.set(pendingId, { providerRefundId: pendingId, status: "pending" });

    await service.reconcile();

    expect((await database.refund.findUniqueOrThrow({ where: { id: processedRefund.id } })).status).toBe("PROCESSED");
    expect((await database.payment.findUniqueOrThrow({ where: { id: processed.payment.id } })).status).toBe("REFUNDED");
    expect((await database.refund.findUniqueOrThrow({ where: { id: failedRefund.id } })).status).toBe("FAILED");
    expect((await database.refund.findUniqueOrThrow({ where: { id: pendingRefund.id } })).status).toBe("REQUESTED");
    expect((await database.refund.findUniqueOrThrow({ where: { id: pendingRefund.id } })).requestedAt).toEqual(clock.now());
  });
  it("starts a new idempotent refund attempt only after the provider confirms a failure", async () => {
    const clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z"));
    const database = getTestDatabase();
    const gateway = new FakeGateway();
    const jobs = new TestJobs();
    const service = createService(gateway, jobs, clock);
    const previousRefundId = `rfnd_${uuidv7()}`;
    const { refund } = await seedPayment({
      status: "REFUND_PENDING",
      consumedAt: clock.now(),
      razorpayRefundId: previousRefundId,
    });
    const seededRefund = requireRefund(refund);
    await database.refund.update({
      where: { id: seededRefund.id },
      data: {
        status: "FAILED",
        requestedAt: new Date("2026-09-20T02:00:00.000Z"),
      },
    });
    gateway.refundStatuses.set(previousRefundId, {
      providerRefundId: previousRefundId,
      status: "failed",
    });

    await service.reconcile();
    const prepared = await database.refund.findUniqueOrThrow({ where: { id: seededRefund.id } });
    expect(prepared.status).toBe("REQUESTED");
    expect(prepared.attemptNumber).toBe(1);
    expect(prepared.razorpayRefundId).toBeNull();
    gateway.refundStatus = "pending";

    await service.executeRefund(seededRefund.id);
    const currentAttempt = await database.refund.findUniqueOrThrow({ where: { id: seededRefund.id } });
    const latestRefundId = currentAttempt.razorpayRefundId;
    expect(latestRefundId).not.toBeNull();
    const eventId = uuidv7();
    await database.webhookEvent.create({
      data: {
        eventId,
        event: "refund.failed",
        payload: { refund: { entity: { id: previousRefundId } } },
      },
    });

    await createWebhookService(service, gateway, jobs, clock).applyWebhook(eventId);

    const unchanged = await database.refund.findUniqueOrThrow({ where: { id: seededRefund.id } });
    expect(unchanged.status).toBe("REQUESTED");
    expect(unchanged.razorpayRefundId).toBe(latestRefundId);
    expect((await database.refundAttempt.findUnique({
      where: {
        refundId_attemptNumber: { refundId: seededRefund.id, attemptNumber: 0 },
      },
    }))?.razorpayRefundId).toBe(previousRefundId);
    expect((await database.refundAttempt.findUnique({
      where: {
        refundId_attemptNumber: { refundId: seededRefund.id, attemptNumber: 1 },
      },
    }))?.razorpayRefundId).toBe(latestRefundId);

    expect(gateway.lastRefundInput?.idempotencyKey).toBe(`${seededRefund.id}-1`);
    expect(gateway.refunds).toBe(1);
  });

  it("reuses the same idempotency key after an unknown refund response", async () => {
    const clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z"));
    const database = getTestDatabase();
    const gateway = new FakeGateway();
    const service = createService(gateway, new TestJobs(), clock);
    const { payment } = await seedPayment();
    await database.$transaction((tx) => service.refund(
      tx,
      payment.id,
      "REGISTRATION_ABANDONED",
      { kind: "SYSTEM" },
    ));
    const refund = await database.refund.findUniqueOrThrow({ where: { paymentId: payment.id } });
    let loseResponse = true;
    gateway.beforeRefund = () => {
      if (loseResponse) {
        loseResponse = false;
        return Promise.reject(new Error("provider response lost"));
      }
      return Promise.resolve();
    };

    await expect(service.executeRefund(refund.id)).rejects.toThrow("provider response lost");
    clock.advance(24 * 60 * 60 * 1000 + 1_000);
    await service.reconcile();
    await service.executeRefund(refund.id);

    expect(gateway.refundInputs.map((input) => input.idempotencyKey)).toEqual([
      refund.id,
      refund.id,
    ]);
  });

  it("recovers a processed refund whose follow-up event predates the outbox", async () => {
    const clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z"));
    const database = getTestDatabase();
    const gateway = new FakeGateway();
    const jobs = new TestJobs();
    const service = createService(gateway, jobs, clock);
    const providerRefundId = `rfnd_${uuidv7()}`;
    const { payment, refund } = await seedPayment({
      status: "REFUNDED",
      consumedAt: clock.now(),
      razorpayRefundId: providerRefundId,
    });
    const seededRefund = requireRefund(refund);
    await database.refund.update({
      where: { id: seededRefund.id },
      data: { status: "PROCESSED", processedAt: clock.now() },
    });

    await service.reconcile();

    const outbox = await database.paymentOutboxJob.findUniqueOrThrow({
      where: { eventKey: `payments.refunded:${payment.id}` },
    });
    expect(outbox.dispatchedAt).not.toBeNull();
    expect(jobs.sent.some((job) => job.name === "payments.refunded.REGISTRATION")).toBe(true);
  });

  it("records the Officer's refund reason on the refund's processing record", async () => {
    const database = getTestDatabase();
    const clock = new FixedClock(new Date("2026-09-22T04:00:00.000Z"));
    const processingRecord = createProcessingRecordWriter({ clock, retentionDays: 365 });
    const payments = new PaymentService({
      db: database,
      gateway: new FakeGateway(),
      jobs: new TestJobs(),
      clock,
      config: {
        razorpayKeyId: "rzp_test_key",
        razorpayKeySecret: "secret",
        paymentIdentityHmacKey: "hmac-key",
        orderCreationClaimLeaseSeconds: 300,
        refundClaimLeaseSeconds: 3600,
        outboxClaimLeaseSeconds: 300,
        outboxJobDedupSeconds: 3600,
      },
      processingRecord,
    });
    const officer = new OfficerService({
      db: database,
      clock,
      retentionDaysConsentAndLogs: 365,
      register: {
        project: () => Promise.resolve(new Map()),
        eraseMember: () => Promise.resolve(),
        readNomineeForOfficer: () => Promise.resolve(null),
        unarchiveMember: () => Promise.resolve({ successionReverted: false }),
      },
      processingRecord,
      payments,
    });
    const { payment } = await seedPayment();

    await officer.refundPayment(payment.id, "officer-1", "  Charged twice for one registration  ");

    const record = await database.processingRecord.findFirstOrThrow({
      where: { action: "REFUND_REQUESTED", subjectId: payment.id },
    });
    expect(record.reason).toBe("Charged twice for one registration");
    await expect(database.refund.findUniqueOrThrow({ where: { paymentId: payment.id } }))
      .resolves.toMatchObject({ reason: "OFFICER", status: "REQUESTED" });
  });
});
