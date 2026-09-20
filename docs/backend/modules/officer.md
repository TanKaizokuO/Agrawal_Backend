# Module: Officer

Owns the Officer's routes, the flag queue and the **Processing Record**. Stage 1: flags, Officer-executed Erasure, image review and removal, member lookup. Stage 2 adds suspension lifts, Report review, Archival tasks and the Nominee read. The unified Officer console is Stage 3; until then the web renders these routes as a minimal protected page.

Read `CONTEXT.md` → Officer, Operator, invariants 18 and 24, and ADR-0013 §7 first. The Officer is one named human (Mr Rahul, who also owns the Operator); the role is still modelled generally.

## Models

```prisma
model ProcessingRecord {                // append-only; see architecture.md
  id          String   @id              // uuid v7
  at          DateTime @default(now())
  actorKind   String                    // OFFICER | OPERATOR | MEMBER | SYSTEM
  actorId     String?                   // memberId, null for SYSTEM
  action      String                    // enum below, stored as text
  subjectType String                    // MEMBER | FAMILY | IMAGE | PAYMENT | NOTICE | FLAG | REGISTRATION | …
  subjectId   String
  reason      String?
  metadata    Json?                     // IDs and outcomes only — never Member field values
  retainUntil DateTime                  // at + RETENTION_DAYS_CONSENT_AND_LOGS, set on insert
  @@index([subjectType, subjectId])
  @@index([actorId, at])
}

model Flag {
  id           String     @id
  kind         FlagKind
  status       FlagStatus @default(OPEN)
  subjectType  String                   // MEMBER | REGISTRATION | FAMILY
  subjectId    String
  relatedIds   Json?                    // e.g. the other Member / Family this one resembles
  createdAt    DateTime   @default(now())
  resolvedAt   DateTime?
  resolvedBy   String?
  resolution   String?                  // CLEARED | ERASED_MEMBER
  note         String?
  @@index([status, createdAt])
}

enum FlagKind {
  NO_PAYMENT_IDENTITY           // founder paid with no usable identity
  POSSIBLE_DUPLICATE_PERSON     // same name + DOB as an existing Member
  SHARED_ADDRESS                // same address as another Family's Head
  JOINER_PAYS_FROM_OTHER_HEAD   // joiner's payment anchors another Family's Head
}
enum FlagStatus { OPEN RESOLVED }
```

### Processing Record actions

`MEMBER_ERASED`, `ERASURE_REQUESTED`, `FLAG_RESOLVED`, `IMAGE_REMOVED`, `IMAGE_OVERRIDE_APPROVED`, `OFFICER_IMAGES_VIEWED`, `OFFICER_MEMBER_LOOKUP`, `NOMINEE_READ`, `REFUND_REQUESTED`, `HEAD_SUCCEEDED`, `FAMILY_ARCHIVED`, `MEMBER_ARCHIVED`, `MEMBER_UNARCHIVED`, `SUSPENSION_LIFTED`, `NOTICE_RESTORED`, `ARCHIVAL_RESOLVED_BY_OFFICER`, `ROLE_GRANTED`, `ROLE_REVOKED`, `BLOOD_SOS_REPORT_RESOLVED`, `PASS_REVOKED`. Keep them in one `ProcessingAction` TypeScript union; add to it rather than inventing free text.

Writing a record is `officer.record(tx, entry)` — synchronous, inside the caller's transaction. A route that performs an Officer action without recording it is a bug; each Officer route's test asserts the record.

## Every automated refusal has an Officer path (invariant 18)

| Automated outcome | Officer reversal | Stage |
|---|---|---|
| Founding refused as a Duplicate Head Attempt | The Applicant joins or is refunded; if the Officer confirms they are a different person, the Officer refunds and asks them to pay from another instrument. No override of `HeadAnchor` exists — one instrument, one Head. | 1 |
| Heuristic duplicate flag | Resolve `CLEARED` (no action) or `ERASED_MEMBER` | 1 |
| Image refused by screening | `POST /v1/officer/images/:id/approve` | 2 (M12) |
| Notice hidden and author suspended by Reports | Lift suspension, restore Notice | 2 |
| False Archival | Unarchive the Member | 2 |
| Blood SOS reported | Review; close the request if abusive | 2 |

## Endpoints

All require role `OFFICER` unless stated. All are rate-limited by `officer.*`.

| Method | Path | Stage | Body → effect |
|---|---|---|---|
| GET | `/v1/officer/flags?status=OPEN&cursor=` | 1 | Flags with the subject's and related Members' SAMAJ projections plus `phoneE164` masked to the last 4 digits; the Payment Identity masked form for identity flags. Records `OFFICER_MEMBER_LOOKUP` for the Member IDs shown. |
| POST | `/v1/officer/flags/:id/resolve` | 1 | `{ outcome: "CLEARED" \| "ERASED_MEMBER", note: string (≤500) }`; `ERASED_MEMBER` runs `register.eraseMember` on the subject in the same transaction. Records `FLAG_RESOLVED` (+ `MEMBER_ERASED`). |
| GET | `/v1/officer/erasure-requests?status=PENDING` | 1 | Pending requests with the Member's SAMAJ projection. |
| POST | `/v1/officer/members/:memberId/erase` | 1 | `{ reason: string, erasureRequestId?: string }` → `register.eraseMember(actor: Officer)`. |
| GET | `/v1/officer/members?phone=\|familyPublicId=\|q=` | 1 | Lookup to act on grievances. Returns SAMAJ projection + masked phone. Records `OFFICER_MEMBER_LOOKUP` with the query kind (not the query value). |
| GET | `/v1/officer/images` | 1 | See `media.md`. |
| POST | `/v1/officer/images/:id/remove` | 1 | See `media.md`. |
| POST | `/v1/officer/payments/:paymentId/refund` | 1 | `{ reason: string }` → `payments.refund(OFFICER)`. |
| GET | `/v1/officer/processing-record?subjectId=&cursor=` | 1 | Read the log for a subject (a grievance answer). |
| POST | `/v1/officer/members/:memberId/nominee-read` | 2 | `{ reason: "CONFIRMED_DEATH" \| "ARCHIVAL_REQUEST", archivalRequestId: string }` → the Nominee's SAMAJ projection + masked phone. Refused `403 NOMINEE_READ_NOT_PERMITTED` unless the Member is ARCHIVED or the Archival Request is open for them (invariant 24). Records `NOMINEE_READ`. |
| POST | `/v1/officer/members/:memberId/unarchive` | 2 | Revert a false Archival. |
| GET | `/v1/officer/suspensions?active=true` | 2 | See `noticeboards.md`. |
| POST | `/v1/officer/suspensions/:id/lift` | 2 | `{ reason, restoreNotice: boolean }`. |
| GET | `/v1/officer/archival-requests?status=ESCALATED` | 2 | See `noticeboards.md`. |
| POST | `/v1/officer/archival-requests/:id/resolve` | 2 | `{ outcome: "CONFIRM" \| "REFUTE", note }`. |
| GET | `/v1/officer/reports?target=BLOOD_SOS` | 2 | Blood SOS reports (never auto-hidden). |
| POST | `/v1/officer/blood-sos/:id/close` | 2 | `{ reason }` — close an abusive request. |
| POST | `/v1/operator/roles` | 2 | Role `OPERATOR`. `{ memberId, role: "ORGANISER" \| "OFFICER", action: "GRANT" \| "REVOKE" }`. Records `ROLE_GRANTED`/`ROLE_REVOKED`. |

Officer responses never include blood group, address, date of birth or the full phone number; the masked last four digits are enough to confirm identity on a call. If a grievance needs more, it is a Member request answered by the Member's own `/v1/me`.

## Public interface (`index.ts`)

```ts
record(tx, entry: ProcessingEntry): Promise<void>
raiseFlag(tx, { kind, subjectType, subjectId, relatedIds? }): Promise<void>
```

## Required tests

- Each Officer route: without the role → 403; with it → effect + exactly one Processing Record of the right action in the same transaction (roll the transaction back and assert neither exists).
- Processing Record: `UPDATE processing_record …` as the app role fails; `DELETE` of a row with future `retainUntil` fails.
- Resolving a flag `ERASED_MEMBER` erases the Member (all invariant-17 assertions hold).
- invariant 24: Nominee read for a living Member with no Archival Request → 403; for an ARCHIVED Member → returned and recorded.
- Officer responses never contain a full phone number, blood group, DOB or address (assert over every Officer route's response).

Module error codes: `FLAG_NOT_FOUND` 404, `FLAG_ALREADY_RESOLVED` 409, `NOMINEE_READ_NOT_PERMITTED` 403.
