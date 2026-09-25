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
function providerOrder(value: unknown): PaymentOrder {
  const entity = isRecord(value) ? value : null;
  if (entity === null) throw new Error("Razorpay order response was not an object");

  const amount = amountPaise(entity.amount);
  const currency = stringValue(entity.currency);
  if (amount === null || currency !== "INR") {
    throw new Error("Razorpay order response had invalid amount or currency");
  }
  return {
    providerOrderId: requiredString(entity.id, "order id"),
    amountPaise: amount,
    currency: "INR",
  };
}

function providerRefund(value: unknown): PaymentRefund {
  const refund = isRecord(value) ? value : null;
  if (refund === null) throw new Error("Razorpay refund response was not an object");
  return {
    providerRefundId: requiredString(refund.id, "refund id"),
    status: requiredString(refund.status, "refund status"),
  };
}

interface RazorpayRequestApi {
  getEntityUrl(input: { readonly url: string }): string;
  rq: {
    post(
      url: string,
      data: unknown,
      options: { readonly headers: Readonly<Record<string, string>> },
    ): Promise<{ readonly data: unknown }>;
  };
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
    return providerOrder(response);
  }

  async findOrderByReceipt(receipt: string): Promise<PaymentOrder | null> {
    const response: unknown = await this.client.orders.all({ receipt, count: 100 });
    const body = isRecord(response) ? response : null;
    if (body === null || !Array.isArray(body.items)) {
      throw new Error("Razorpay orders response was invalid");
    }
    const found: unknown = body.items.find((item) => isRecord(item) && item.receipt === receipt);
    return found === undefined ? null : providerOrder(found);
  }

  async refund(input: {
    readonly providerPaymentId: string;
    readonly amountPaise: number;
    readonly speed: "normal";
    readonly notes: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }): Promise<PaymentRefund> {
    // The pinned Razorpay SDK does not expose per-request headers on refunds.
    // Use its authenticated Axios transport without mutating shared defaults.
    const api = this.client.api as unknown as RazorpayRequestApi;
    const response = await api.rq.post(
      api.getEntityUrl({ url: `/payments/${input.providerPaymentId}/refund` }),
      {
        amount: input.amountPaise,
        speed: input.speed,
        notes: { ...input.notes },
      },
      { headers: { "X-Refund-Idempotency": input.idempotencyKey } },
    );
    return providerRefund(response.data);
  }

  async fetchRefund(providerRefundId: string): Promise<PaymentRefund> {
    return providerRefund(await this.client.refunds.fetch(providerRefundId));
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

}

export function createRazorpayGateway(options: RazorpayGatewayOptions): PaymentGateway {
  return new RazorpayPaymentGateway(options);
}
