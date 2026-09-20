import Razorpay from "razorpay";
import type {
  PaymentGateway,
  PaymentOrder,
  PaymentProviderPayment,
  PaymentRefund,
} from "./ports.js";
import { isRecord } from "./guards.js";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function amountPaise(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function requiredString(value: unknown, field: string): string {
  const result = stringValue(value);
  if (result === null) throw new Error(`Razorpay response missing ${field}`);
  return result;
}

function payment(value: unknown): PaymentProviderPayment {
  const entity = isRecord(value) ? value : null;
  if (entity === null) throw new Error("Razorpay payment response was not an object");

  const card = isRecord(entity.card) ? entity.card : null;
  return {
    id: requiredString(entity.id, "payment id"),
    orderId: stringValue(entity.order_id),
    status: requiredString(entity.status, "payment status"),
    amountPaise: amountPaise(entity.amount),
    method: stringValue(entity.method),
    vpa: stringValue(entity.vpa),
    cardId: stringValue(entity.card_id),
    cardLast4: stringValue(card?.last4),
    errorDescription: stringValue(entity.error_description),
  };
}

export interface RazorpayGatewayOptions {
  readonly keyId: string;
  readonly keySecret: string;
}

export class RazorpayPaymentGateway implements PaymentGateway {
  private readonly client: Razorpay;

  constructor(options: RazorpayGatewayOptions) {
    this.client = new Razorpay({
      key_id: options.keyId,
      key_secret: options.keySecret,
    });
  }

  async createOrder(input: {
    readonly amountPaise: number;
    readonly currency: "INR";
    readonly receipt: string;
    readonly notes: Readonly<Record<string, string>>;
  }): Promise<PaymentOrder> {
    const response: unknown = await this.client.orders.create({
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: { ...input.notes },
    });
    const created = isRecord(response) ? response : null;
    if (created === null) throw new Error("Razorpay order response was not an object");

    const amount = amountPaise(created.amount);
    const currency = stringValue(created.currency);
    if (amount === null || currency !== "INR") {
      throw new Error("Razorpay order response had invalid amount or currency");
    }
    return {
      providerOrderId: requiredString(created.id, "order id"),
      amountPaise: amount,
      currency: "INR",
    };
  }

  async fetchPayment(providerPaymentId: string): Promise<PaymentProviderPayment> {
    const response: unknown = await this.client.payments.fetch(providerPaymentId);
    return payment(response);
  }

  async fetchOrderPayments(providerOrderId: string): Promise<readonly PaymentProviderPayment[]> {
    const response: unknown = await this.client.orders.fetchPayments(providerOrderId);
    const body = isRecord(response) ? response : null;
    if (body === null || !Array.isArray(body.items)) {
      throw new Error("Razorpay order payments response was invalid");
    }
    return body.items.map((item) => payment(item));
  }

  async capture(input: {
    readonly providerPaymentId: string;
    readonly amountPaise: number;
  }): Promise<PaymentProviderPayment> {
    const response: unknown = await this.client.payments.capture(
      input.providerPaymentId,
      input.amountPaise,
      "INR",
    );
    return payment(response);
  }

  async refund(input: {
    readonly providerPaymentId: string;
    readonly amountPaise: number;
    readonly speed: "normal";
    readonly notes: Readonly<Record<string, string>>;
  }): Promise<PaymentRefund> {
    const response: unknown = await this.client.payments.refund(input.providerPaymentId, {
      amount: input.amountPaise,
      speed: input.speed,
      notes: { ...input.notes },
    });
    const refund = isRecord(response) ? response : null;
    if (refund === null) throw new Error("Razorpay refund response was not an object");
    return {
      providerRefundId: requiredString(refund.id, "refund id"),
      status: requiredString(refund.status, "refund status"),
    };
  }
}

export function createRazorpayGateway(options: RazorpayGatewayOptions): PaymentGateway {
  return new RazorpayPaymentGateway(options);
}
