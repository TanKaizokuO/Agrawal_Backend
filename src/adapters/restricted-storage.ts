import type { PaymentTxClient, RestrictedStorageMover } from "../modules/payments/index.js";

interface PaymentRow {
  readonly id: string;
  readonly purpose: string;
  readonly subjectId: string;
  readonly payerPhoneE164: string;
  readonly payerMemberId: string | null;
  readonly amountPaise: number;
  readonly currency: string;
  readonly status: string;
  readonly razorpayOrderId: string;
  readonly razorpayPaymentId: string | null;
  readonly method: string | null;
  readonly identityKind: string | null;
  readonly identityHash: string | null;
  readonly identityMasked: string | null;
  readonly capturedAt: Date | null;
  readonly failedAt: Date | null;
  readonly failureReason: string | null;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RefundRow {
  readonly id: string;
  readonly paymentId: string;
  readonly reason: string;
  readonly amountPaise: number;
  readonly razorpayRefundId: string | null;
  readonly status: string;
  readonly requestedAt: Date;
  readonly processedAt: Date | null;
  readonly attemptNumber: number;
  readonly failureReason: string | null;
}

interface RefundAttemptRow {
  readonly refundId: string;
  readonly attemptNumber: number;
  readonly razorpayRefundId: string | null;
  readonly createdAt: Date;
}

export class PrismaRestrictedStorageMover implements RestrictedStorageMover {
  public async movePayments(
    tx: PaymentTxClient,
    payerMemberId: string,
    retainUntil: Date,
  ): Promise<void> {
    const payments: PaymentRow[] = await tx.payment.findMany({ where: { payerMemberId } });
    if (payments.length === 0) return;
    const ids = payments.map((payment: PaymentRow) => payment.id);
    const refunds: RefundRow[] = await tx.refund.findMany({
      where: { paymentId: { in: ids } },
    });
    const refundIds = refunds.map((refund: RefundRow) => refund.id);
    const attempts: RefundAttemptRow[] = await tx.refundAttempt.findMany({
      where: { refundId: { in: refundIds } },
    });

    for (const payment of payments) {
      await this.copyPayment(tx, payment, retainUntil);
    }
    for (const refund of refunds) {
      await this.copyRefund(tx, refund, retainUntil);
    }
    for (const attempt of attempts) {
      await this.copyRefundAttempt(tx, attempt, retainUntil);
    }
    if (refundIds.length > 0) {
      await tx.refundAttempt.deleteMany({ where: { refundId: { in: refundIds } } });
    }
    for (const refund of refunds) {
      await tx.$executeRaw`DELETE FROM refund WHERE id = ${refund.id}`;
    }
    for (const payment of payments) {
      await tx.$executeRaw`DELETE FROM payment WHERE id = ${payment.id}`;
    }
  }

  private async copyPayment(
    tx: PaymentTxClient,
    payment: PaymentRow,
    retainUntil: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO restricted.payment (
        id, purpose, subject_id, payer_phone_e164, payer_member_id,
        amount_paise, currency, status, razorpay_order_id, razorpay_payment_id,
        method, identity_kind, identity_hash, identity_masked, captured_at,
        failed_at, failure_reason, consumed_at, created_at, updated_at, retain_until
      ) VALUES (
        ${payment.id}, ${payment.purpose}, ${payment.subjectId}, ${payment.payerPhoneE164},
        ${payment.payerMemberId}, ${payment.amountPaise}, ${payment.currency}, ${payment.status},
        ${payment.razorpayOrderId}, ${payment.razorpayPaymentId}, ${payment.method},
        ${payment.identityKind}, ${payment.identityHash}, ${payment.identityMasked},
        ${payment.capturedAt}, ${payment.failedAt}, ${payment.failureReason}, ${payment.consumedAt},
        ${payment.createdAt}, ${payment.updatedAt}, ${retainUntil}
      ) ON CONFLICT (id) DO NOTHING
    `;
  }

  private async copyRefund(
    tx: PaymentTxClient,
    refund: RefundRow,
    retainUntil: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO restricted.refund (
        id, payment_id, reason, amount_paise, razorpay_refund_id, status,
        requested_at, processed_at, attempt_number, failure_reason, retain_until
      ) VALUES (
        ${refund.id}, ${refund.paymentId}, ${refund.reason}, ${refund.amountPaise},
        ${refund.razorpayRefundId}, ${refund.status}, ${refund.requestedAt},
        ${refund.processedAt}, ${refund.attemptNumber}, ${refund.failureReason}, ${retainUntil}
      ) ON CONFLICT (id) DO NOTHING
    `;
  }

  private async copyRefundAttempt(
    tx: PaymentTxClient,
    attempt: RefundAttemptRow,
    retainUntil: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO restricted.refund_attempt (
        refund_id, attempt_number, razorpay_refund_id, created_at, retain_until
      ) VALUES (
        ${attempt.refundId}, ${attempt.attemptNumber}, ${attempt.razorpayRefundId},
        ${attempt.createdAt}, ${retainUntil}
      ) ON CONFLICT (refund_id, attempt_number) DO NOTHING
    `;
  }
}

export function createRestrictedStorageMover(): RestrictedStorageMover {
  return new PrismaRestrictedStorageMover();
}
