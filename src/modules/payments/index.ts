import type { PaymentTxClient } from "./db.js";

/**
 * Payments module public interface.
 *
 * This is the ONLY file other modules may import from this module.
 */
export {
  PaymentService,
  extractIdentity,
  verifyCheckoutSignature,
  type PaymentServiceConfig,
  type PaymentServiceDeps,
  type CreateOrderInput,
  type OrderForCheckout,
  type PaymentView,
  type PaymentIdentity,
  type PaymentViewer,
  type PaymentPurpose,
  type IdentityKind,
  type ExtractedIdentity,
  type RefundReason,
  type Actor,
  type ProcessingRecordWriter,
  type RestrictedStorageMover,
} from "./service.js";

export {
  PaymentWebhookService,
  verifyWebhookSignature,
  type PaymentWebhookEffects,
  type PaymentWebhookLogger,
  type PaymentWebhookServiceDeps,
} from "./webhooks.js";

export {
  PaymentCapturedPayload,
  paymentCapturedJobName,
} from "./events.js";

/** The small seam consumed by Register for erasure and head succession. */
export interface PaymentsPort {
  moveToRestricted(tx: PaymentTxClient, payerMemberId: string, retainUntil: Date): Promise<void>;
  releaseHeadAnchor(tx: PaymentTxClient, familyId: string): Promise<void>;
}

export {
  createPaymentRoutes,
  createWebhookHandler,
  paymentRouteManifest,
  type PaymentWebhookRouteDeps,
} from "./routes.js";

export {
  createPaymentWorkers,
  JOB_NAMES as PAYMENT_JOB_NAMES,
  JOB_SCHEDULES as PAYMENT_JOB_SCHEDULES,
} from "./jobs.js";

export type {
  PaymentDatabase,
  PaymentTxClient,
} from "./db.js";
