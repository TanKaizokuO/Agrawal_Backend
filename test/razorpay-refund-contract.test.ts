import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { RazorpayPaymentGateway } from "../src/adapters/razorpay.js";

interface RazorpayClientSeam {
  api: {
    getEntityUrl(input: { readonly url: string }): string;
    rq: {
      post(
        url: string,
        data: unknown,
        options: { readonly headers: Readonly<Record<string, string>> },
      ): Promise<{ readonly data: unknown }>;
    };
  };
  refunds: {
    fetch(providerRefundId: string): Promise<unknown>;
  };
}

describe("Razorpay refund adapter", () => {
  it("sends the deterministic key as Razorpay's per-request refund idempotency header", async () => {
    const gateway = new RazorpayPaymentGateway({ keyId: "key-id", keySecret: "key-secret" });
    // Substitute the pinned SDK transport so the test can inspect the outbound request.
    const sdk = gateway as unknown as { client: RazorpayClientSeam };
    const client = sdk.client;
    const idempotencyKey = uuidv7();
    let request: {
      readonly url: string;
      readonly data: unknown;
      readonly headers: Readonly<Record<string, string>>;
    } | undefined;
    client.api.rq.post = (url, data, options) => {
      request = { url, data, headers: options.headers };
      return Promise.resolve({ data: { id: "rfnd_provider", status: "pending" } });
    };

    const result = await gateway.refund({
      providerPaymentId: "pay_provider",
      amountPaise: 10_000,
      speed: "normal",
      notes: { reason: "REGISTRATION_ABANDONED" },
      idempotencyKey,
    });

    expect(result).toEqual({ providerRefundId: "rfnd_provider", status: "pending" });
    expect(request).toEqual({
      url: "/v1/payments/pay_provider/refund",
      data: { amount: 10_000, speed: "normal", notes: { reason: "REGISTRATION_ABANDONED" } },
      headers: { "X-Refund-Idempotency": idempotencyKey },
    });
  });

  it("fetches the status of a known provider refund", async () => {
    const gateway = new RazorpayPaymentGateway({ keyId: "key-id", keySecret: "key-secret" });
    // The private SDK client is the adapter's existing provider boundary.
    const sdk = gateway as unknown as { client: RazorpayClientSeam };
    const client = sdk.client;
    client.refunds.fetch = () => Promise.resolve({ id: "rfnd_provider", status: "processed" });

    await expect(gateway.fetchRefund("rfnd_provider")).resolves.toEqual({
      providerRefundId: "rfnd_provider",
      status: "processed",
    });
  });
});
