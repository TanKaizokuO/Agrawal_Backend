import { describe, expect, it, vi } from "vitest";
import { createNoticesWorkers, NOTICES_JOB_NAMES, type NoticesService } from "../src/modules/notices/index.js";

describe("payments.captured.BUSINESS_LISTING worker", () => {
  it("publishes the listing for the payload PaymentService sends", async () => {
    const onPaymentCaptured = vi.fn(() => Promise.resolve());
    const service = { onPaymentCaptured } as unknown as NoticesService;
    const worker = createNoticesWorkers(service).find(
      (registration) => registration.name === NOTICES_JOB_NAMES.paymentCaptured,
    );
    const paymentId = crypto.randomUUID();
    const subjectId = crypto.randomUUID();

    // Shape sent by PaymentService.applyCapture.
    await worker?.handler({ paymentId, subjectId });

    expect(onPaymentCaptured).toHaveBeenCalledWith({
      id: paymentId,
      subjectId,
      purpose: "BUSINESS_LISTING",
    });
  });

  it("rejects malformed payloads instead of dropping them silently", async () => {
    const service = { onPaymentCaptured: vi.fn() } as unknown as NoticesService;
    const worker = createNoticesWorkers(service).find(
      (registration) => registration.name === NOTICES_JOB_NAMES.paymentCaptured,
    );

    await expect(Promise.resolve(worker?.handler({ id: "x" }))).rejects.toThrow();
  });
});
