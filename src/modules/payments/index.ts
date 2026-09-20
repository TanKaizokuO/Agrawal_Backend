import type { PaymentTxClient } from "./db.js";

/**
 * Payments module public interface.
 *
 * This is the ONLY file other modules may import from this module.
 */
export {
  PaymentService,
  extractIdentity,
  verifyWebhookSignature,
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

/** The small seam consumed by Register for erasure and head succession. */
export interface PaymentsPort {
  moveToRestricted(tx: PaymentTxClient, payerMemberId: string, retainUntil: Date): Promise<void>;
  releaseHeadAnchor(tx: PaymentTxClient, familyId: string): Promise<void>;
}

export {
  createPaymentRoutes,
  createWebhookHandler,
  paymentRouteManifest,
  type PaymentRouteDeps,
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
