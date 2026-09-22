import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import type { PaymentGateway } from "../src/adapters/ports.js";
import { FixedClock } from "../src/clock.js";
import type { JobRuntime } from "../src/jobs.js";
import { PaymentService } from "../src/modules/payments/index.js";
import { getTestDatabase } from "./setup.js";

class FakeGateway implements PaymentGateway {
  orders = 0;
  refunds = 0;

  createOrder(input: { readonly amountPaise: number }) {
    this.orders += 1;
    return Promise.resolve({ providerOrderId: `order_${uuidv7()}`, amountPaise: input.amountPaise, currency: "INR" as const });
  }

  fetchPayment(): never {
    throw new Error("not used");
  }

  fetchOrderPayments(): never {
    throw new Error("not used");
  }

  capture(): never {
    throw new Error("not used");
  }

  refund() {
    this.refunds += 1;
    return Promise.resolve({ providerRefundId: `rfnd_${uuidv7()}`, status: "pending" });
  }
}

const jobs: JobRuntime = {
  send: () => Promise.resolve(null),
  registerWorker: () => Promise.resolve(),
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  isReady: () => Promise.resolve(true),
  enabled: false,
};

function createService(gateway: FakeGateway): PaymentService {
  return new PaymentService({
    db: getTestDatabase(),
    gateway,
    jobs,
    clock: new FixedClock(new Date("2026-09-22T04:00:00.000Z")),
    config: {
      razorpayKeyId: "rzp_test_key",
      razorpayKeySecret: "secret",
      razorpayWebhookSecret: "webhook-secret",
      paymentIdentityHmacKey: "hmac-key",
    },
  });
}

describe("Payment advisory locks", () => {
  it("creates one order for concurrent checkouts of the same subject", async () => {
    const gateway = new FakeGateway();
    const service = createService(gateway);
    const order = {
      purpose: "REGISTRATION" as const,
      subjectId: uuidv7(),
      payerPhoneE164: "+919876543210",
      amountPaise: 10_000,
    };

    const [first, second] = await Promise.all([service.createOrder(order), service.createOrder(order)]);

    expect(second.paymentId).toBe(first.paymentId);
    expect(gateway.orders).toBe(1);
  });

  it("sends a requested refund to the gateway", async () => {
    const gateway = new FakeGateway();
    const service = createService(gateway);
    const database = getTestDatabase();
    const paymentId = uuidv7();
    await database.payment.create({
      data: {
        id: paymentId,
        purpose: "REGISTRATION",
        subjectId: uuidv7(),
        payerPhoneE164: "+919876543210",
        amountPaise: 10_000,
        status: "CAPTURED",
        razorpayOrderId: `order_${uuidv7()}`,
        razorpayPaymentId: `pay_${uuidv7()}`,
      },
    });
    await database.$transaction((tx) => service.refund(tx, paymentId, "REGISTRATION_ABANDONED", { kind: "SYSTEM" }));
    const refund = await database.refund.findUniqueOrThrow({ where: { paymentId } });

    await service.executeRefund(refund.id);

    expect(gateway.refunds).toBe(1);
    expect((await database.refund.findUniqueOrThrow({ where: { id: refund.id } })).razorpayRefundId).toMatch(/^rfnd_/u);
  });
});
