# Module: Payments

Owns every movement of money: Razorpay orders, payment capture, refunds, webhook ingestion, reconciliation, and the Payment Identity. Stage 1 (Registration Payment); Stage 2 adds the Business Listing Posting Fee.

## Facts about Razorpay this module is built on

Verified against Razorpay's first-party docs on 18 September 2026:

- The payer's identity is only on the **Payment entity after authorization**: `vpa` for UPI; `card_id` for cards; nothing stable for netbanking or wallets. There is no way to learn it before money moves with UPI Intent or QR. The VPA-validation API works only with UPI Collect, which NPCI is retiring. So ADR-0010's "refused before money moves" cannot be built; the rule is **refuse and refund once the payment reveals the identity** (`CONTEXT.md`, Duplicate Head Attempt).
- The docs do not promise `vpa` is always present and unmasked for Intent/QR payments. Treat an absent or masked `vpa` as "no usable identity".
- Standard Checkout's methods can't be restricted from client config; an account-level change needs Razorpay support. Assume any method can arrive.
- Webhook signature: `X-Razorpay-Signature` = hex HMAC-SHA256 of the **raw request body** keyed by the webhook secret. Verify before parsing. Events used: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`. Each webhook carries an `x-razorpay-event-id` header for dedup.
- Configure **automatic capture** on the Razorpay account (dashboard → payment capture settings) so an authorized payment is captured without an API call. A payment stuck `authorized` is captured by the reconciliation job.

## Models

```prisma
model Payment {
  id                 String         @id                 // uuid v7
  purpose            PaymentPurpose
  subjectId          String                             // registrationId or businessListingId
  payerPhoneE164     String
  payerMemberId      String?                            // null for an Applicant
  amountPaise        Int                                // what was actually charged (ADR-0008)
  currency           String         @default("INR")
  status             PaymentStatus  @default(CREATED)
  razorpayOrderId    String         @unique
  razorpayPaymentId  String?        @unique
  method             String?                            // upi | card | netbanking | wallet | …
  identityKind       IdentityKind?                      // VPA | CARD | NONE
  identityHash       String?                            // HMAC-SHA256(key, normalized value), hex
  identityMasked     String?                            // "ra****@okaxis", "card ••1234" — for the Officer only
  capturedAt         DateTime?
  failedAt           DateTime?
  failureReason      String?
  consumedAt         DateTime?                          // when the subject used it (founding, joining, publication)
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt
  retainUntil        DateTime?                          // set when the payer is erased; see register.md Erasure
  refunds            Refund[]
  @@index([subjectId])
  @@index([identityHash])
  @@index([status, createdAt])
}

enum PaymentPurpose { REGISTRATION BUSINESS_LISTING }
enum PaymentStatus  { CREATED CAPTURED FAILED REFUND_PENDING REFUNDED }
enum IdentityKind   { VPA CARD NONE }

model Refund {
  id                  String          @id
  paymentId           String
  payment             Payment         @relation(fields: [paymentId], references: [id])
  reason              RefundReason
  amountPaise         Int
  razorpayRefundId    String?         @unique // current attempt's provider ID
  status              RefundStatus    @default(REQUESTED)
  requestedAt         DateTime        @default(now())
  processedAt         DateTime?
  processingStartedAt DateTime?
  attemptNumber       Int             @default(0)
  failureReason       String?
  attempts            RefundAttempt[]
  @@unique([paymentId])                    // one full refund per payment, ever
}

model RefundAttempt {
  refundId         String
  refund           Refund   @relation(fields: [refundId], references: [id])
  attemptNumber    Int
  razorpayRefundId String?  @unique
  createdAt        DateTime @default(now())
  @@id([refundId, attemptNumber])
}

enum RefundReason {
  DUPLICATE_HEAD            // founding refused on a Payment Identity repeat
  JOIN_DECLINED
  JOIN_EXPIRED
  REGISTRATION_CANCELLED    // Applicant cancelled a pending join
  REGISTRATION_ABANDONED
  PUBLICATION_FAILED        // Commercial Notice could not publish (technical)
  OFFICER                   // Officer-initiated, e.g. a wrongly refused founder
}
enum RefundStatus { REQUESTED PROCESSING PROCESSED FAILED }

model HeadAnchor {
  identityHash  String   @id                 // one identity heads at most one Family (invariant 6)
  familyId      String   @unique
  paymentId     String
  createdAt     DateTime @default(now())
}

model WebhookEvent {
  eventId     String   @id                   // x-razorpay-event-id
  event       String
  receivedAt  DateTime @default(now())
  processedAt DateTime?
  payload     Json
}
```

`HeadAnchor` rows are written by Registration at founding (through this module's interface) and removed only when the anchored Family is archived with no remaining adult Members — never on Head succession, so a person who handed a Family on still cannot found a second one with the same instrument.

## Payment Identity

`extractIdentity(razorpayPayment)`:

| `method` | Rule | `identityKind` | Normalized value |
|---|---|---|---|
| `upi` | `vpa` present, contains `@`, not containing `*` | `VPA` | `vpa.trim().toLowerCase()` |
| `card` | `card_id` present | `CARD` | `card_id` |
| anything else, or the above missing | | `NONE` | — |

`identityHash = HMAC-SHA256(PAYMENT_IDENTITY_HMAC_KEY, kind + ":" + value)`. The raw VPA is not stored; `identityMasked` keeps the first two characters of the handle and the full PSP suffix (`ra****@okaxis`), or `card ••<last4>`.

## Flows

### Create an order

`payments.createOrder({ purpose, subjectId, payerPhoneE164, payerMemberId?, amountPaise })` — called by Registration or Noticeboards, never by a client directly.

1. If a `Payment` for this `subjectId` is already `CAPTURED` or `REFUND_PENDING` → return it (`alreadyPaid: true`); never a second charge.
2. If a `CREATED` payment exists for this subject younger than 30 minutes → return its order (the client may have lost the checkout).
3. Otherwise reserve the unique `(purpose, subjectId)` `PaymentOrderClaim` in a short database transaction. Its payment ID is also the stable Razorpay receipt. Call `orders.create` outside the transaction, then insert the `Payment` and delete the claim atomically. Concurrent callers on the same `PaymentService` instance share its in-flight promise; callers on another instance see an active claim and receive `503` rather than starting another provider request. Retry after the owner commits returns the persisted order. If the claim lease expires after an unknown provider outcome, look up the order by its receipt before retrying creation.
4. `PaymentOrderClaim` is the single durable coordination record; `razorpayOrderId` remains non-null and no placeholder value is written. The claim model and table are already present in the payment-reliability schema/migration; no draft Payment state is needed.
5. Return `{ paymentId, razorpayOrderId, keyId: RAZORPAY_KEY_ID, amountPaise, currency, prefill: { contact: payerPhoneE164 } }`. The client opens `checkout.js` with it (ADR-0014 §11).

### Client confirmation (fast path)

`POST /v1/payments/:paymentId/confirm` `{ razorpayPaymentId, razorpayOrderId, razorpaySignature }` — the Checkout success handler's values. The server verifies the checkout signature (`HMAC-SHA256(key_secret, order_id + "|" + payment_id)`), then **fetches the payment from Razorpay's API** and applies it exactly as a webhook would. Client-supplied fields are never applied directly. Returns the Payment's current status. This makes the UI fast when the webhook is slow; the webhook remains authoritative and idempotent against it.

### Webhook

`POST /v1/webhooks/razorpay`, mounted **before** `express.json()` with `express.raw({ type: "application/json", limit: "1mb" })`.

1. Verify `X-Razorpay-Signature` over the raw bytes with `crypto.timingSafeEqual`. Invalid → `400`, log at `warn`, nothing stored.
2. Insert `WebhookEvent` keyed by `x-razorpay-event-id`. A completed replay is acknowledged without reprocessing; an unprocessed event is enqueued again so a prior queue failure is recoverable.
3. Enqueue `payments.applyWebhook` with the event ID; return `200` within Razorpay's timeout. All processing is in the job.

`PaymentWebhookService` owns raw-byte signature verification, JSON parsing, durable event ingestion/deduplication, and event orchestration. Its stable operations are `receive(rawBody, signature, eventId)` at the HTTP seam and `applyWebhook(eventId)` in the worker. It delegates provider-state changes to `PaymentService`; capture/refund state transitions and their outbox writes therefore remain in the same transactions as before.

`payments.applyWebhook`:

| Event | Effect |
|---|---|
| `payment.captured` / `order.paid` | Find the `Payment` by `order_id`. If already captured/refund-pending/refunded, preserve its state; otherwise set `CAPTURED`, `razorpayPaymentId`, `method`, identity fields and `capturedAt`. In the same transaction write a `payments.captured.<PURPOSE>` outbox job with `{ paymentId, subjectId }`. |
| `payment.failed` | If `CREATED`, set `FAILED`, `failureReason = error_description`. A later successful payment on the same order still wins. |
| `refund.processed` | Match the provider refund ID to its recorded `RefundAttempt`. Only the current attempt may transition Refund → `PROCESSED`; Payment → `REFUNDED`; write `payments.refunded.<PURPOSE>` to the outbox in the same transaction. Delayed events for older attempts are ignored. |
| `refund.failed` | Match the provider refund ID to its recorded attempt. Only the current attempt may transition Refund → `FAILED`; alert the Operator (log at `error` with stable message `REFUND_FAILED`). Reconciliation checks provider state and retries failed attempts once a day. |

The outbox uses a claim lease to dispatch jobs to pg-boss and remains recoverable when enqueueing fails. `refund(tx, ...)` writes the refund-execution outbox record in the caller's transaction; it never calls the gateway or dispatches a job before commit. Captured payments whose subject has not consumed the payment are swept by reconciliation; an unconsumed capture event is re-dispatched after an hour.

### Refund

`payments.refund(tx, paymentId, reason)`: idempotent — if a `Refund` exists for the payment, return it. Otherwise insert `Refund(REQUESTED)`, set the Payment `REFUND_PENDING`, write a Processing Record (`REFUND_REQUESTED`, actor `SYSTEM` or `OFFICER`), and insert a `payments.executeRefund` outbox row in the caller's transaction. The gateway is never called and the job is never dispatched before that transaction commits.

The worker atomically claims `REQUESTED` → `PROCESSING` in a database transaction, including reclaiming an expired `PROCESSING` lease or an eligible `FAILED` attempt, then commits before calling Razorpay. Unknown outcomes reuse the attempt's deterministic idempotency key; a provider-confirmed failure starts a new attempt no more than once per day with a new key. Every attempt retains its own provider refund ID. Webhooks and reconciliation match that ID to the recorded attempt and may update the Refund only while that attempt is current. A provider-created refund remains `REQUESTED` until Razorpay reports `processed` or `failed`. Full refunds only.

### Payment worker configuration

Lease and pg-boss deduplication windows are configured in seconds through these existing payment settings:

| Environment variable | Default | Purpose |
|---|---:|---|
| `PAYMENT_ORDER_CLAIM_LEASE_SECONDS` | 300 | Order-creation claim lease |
| `PAYMENT_REFUND_CLAIM_LEASE_SECONDS` | 3600 | Refund-attempt claim lease |
| `PAYMENT_OUTBOX_CLAIM_LEASE_SECONDS` | 300 | Outbox-dispatch claim lease |
| `PAYMENT_OUTBOX_JOB_DEDUP_SECONDS` | 3600 | pg-boss singleton deduplication window |

### Reconciliation (`payments.reconcile`, every 10 minutes)

- `CREATED` payments aged 5 minutes to 48 hours: fetch the order's payments from Razorpay; apply any `captured` one; capture any stuck `authorized` one (`payments.capture`) — log at `error` "WEBHOOK_MISSED" when a capture is found this way. A provider error for one payment is logged and does not stop other payments or refund work.
- `CREATED` payments older than 48 hours with nothing captured → `FAILED` (`ORDER_ABANDONED`).
- `CAPTURED`/`REFUND_PENDING`/`REFUNDED` payments with `consumedAt = null` → ensure and dispatch their captured-payment outbox job.
- `REQUESTED` refunds older than 1 hour with a provider refund ID → fetch provider state and apply `PROCESSED` or `FAILED`; pending refunds stay requested. Without an ID, enqueue the same attempt after its lease expires.
- Expired `PROCESSING` leases without a provider refund ID → re-enqueue the same attempt; its claim and deterministic provider idempotency key make recovery safe.
- `FAILED` refunds with a provider refund ID → fetch provider state; if it is still failed, start a new attempt only after one day. Without an ID, retry the same attempt at most once per day with its existing idempotency key.
- `PROCESSED` refunds with no refund outbox record (for example, from before outbox deployment) → create and dispatch `payments.refunded.<PURPOSE>`.
- Drain undispatched outbox rows on every run; each payment, refund, and outbox item is isolated, and failures log the caught exception with their payment/refund/outbox identifiers.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/payments/:paymentId/confirm` | principal (the payer) | Fast-path confirmation; idempotent. |
| GET | `/v1/payments/:paymentId` | principal (the payer) | `{ paymentId, purpose, status, amountPaise, currency, method, capturedAt, refund: { status, reason } \| null }` — never the identity. |
| POST | `/v1/webhooks/razorpay` | public, signature-verified | Raw body. |

Order creation endpoints belong to the purpose's module (`/v1/registration/payment-order`, `/v1/business-listings/:id/payment-order`).

Module error codes: `PAYMENT_NOT_FOUND` 404, `PAYMENT_SIGNATURE_INVALID` 400, `PAYMENT_ALREADY_CAPTURED` 409.

## Public interface (`index.ts`)

```ts
createOrder(input): Promise<OrderForCheckout>
getForSubject(subjectId: string): Promise<PaymentView | null>        // latest non-failed
markConsumed(tx, paymentId: string): Promise<void>
refund(tx, paymentId: string, reason: RefundReason, actor: Actor): Promise<void>
identityOf(paymentId: string): Promise<{ kind: IdentityKind; hash: string | null; masked: string | null }>
findHeadAnchor(identityHash: string): Promise<{ familyId: string } | null>
createHeadAnchor(tx, { identityHash, familyId, paymentId }): Promise<void>   // unique violation → DUPLICATE_HEAD
releaseHeadAnchor(tx, familyId: string): Promise<void>
moveToRestricted(tx, payerMemberId: string, retainUntil: Date): Promise<void>  // Erasure
```

## Required tests

- Webhook with a bad signature → 400, nothing stored. Good signature → 200 and the payment captured after `drainJobs()`.
- The same webhook delivered twice → one capture and an idempotent `payments.captured.*` outbox event.
- A captured payment whose job enqueue fails remains recoverable through its outbox row and reconciliation.
- `payment.failed` then `payment.captured` on the same order → `CAPTURED`.
- Fast-path confirm with a forged `razorpaySignature` → 400; with a valid one → status from the (fake) Razorpay fetch, not from the body.
- `createOrder` on an already-captured subject returns `alreadyPaid` and creates no order.
- Razorpay order creation observes a committed `PaymentOrderClaim`; same-instance concurrent callers share one order, separate instances cannot create a second order while the claim is active, and retry after commit returns the stored order. An unknown provider outcome is recovered through the stable receipt.
- A bad webhook signature stores nothing; a valid signed webhook is durably ingested, applied once, and writes captured/refunded outbox work transactionally.
- Identity extraction: UPI with `vpa` → `VPA`; UPI with masked or missing `vpa` → `NONE`; card → `CARD`; netbanking → `NONE`. Case-different VPAs hash equal.
- Concurrent `executeRefund` calls make one gateway request with the refund ID as the idempotency key.
- `refund` twice → one `Refund`, one gateway call.
- A processed refund webhook dispatches `payments.refunded.<PURPOSE>` from the transactional outbox.
- A pre-outbox processed refund with no outbox row is recovered by reconciliation.
- Reconcile finds a captured payment the webhook missed and applies it; one Razorpay failure does not prevent later payment/refund items from reconciling.
- A provider-confirmed failed refund may retry daily with a new deterministic key; an unknown network outcome reuses its attempt key.
- A requested refund with a provider refund ID converges to the provider's processed or failed status.
- invariant 6: `createHeadAnchor` with an existing hash fails with `DUPLICATE_HEAD`.
