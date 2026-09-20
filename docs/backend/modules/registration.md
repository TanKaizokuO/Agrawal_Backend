# Module: Registration

Owns Applicants' Registrations: from a verified phone to a Member, by founding a Family or joining one. Owns Family ID minting and the Head's confirmation of joins. Stage 1.

Read `CONTEXT.md` → Applicant, Registration, Registration Payment, Payment Identity, Duplicate Head Attempt, Family ID, Invite first.

## Lifecycle

```
            sign-in (new phone)
                  │
               STARTED ──────────────┐ idle 24h / re-sign-in / cancel
                  │ payment captured  │
                 PAID ───────────────┤──► ABANDONED  (refund if PAID)
       ┌──────────┴──────────┐        │
 submit FOUND            submit JOIN  │
       │                     │        │
   COMPLETED            AWAITING_HEAD ┤──► CANCELLED  (Applicant withdrew; refund)
  (Member + Family)          │        │
              ┌──────────────┼──────────────┐
         Head approves   Head declines   14 days pass
              │              │              │
          COMPLETED      DECLINED        EXPIRED
         (Member)        (refund)        (refund)
```

- A Registration **completes** only in `COMPLETED`. The Applicant becomes a Member in that same transaction and not before (`CONTEXT.md`, Registration).
- Every non-completing end state — `ABANDONED`, `CANCELLED`, `DECLINED`, `EXPIRED` — refunds a captured Registration Payment and purges the Applicant's submitted profile and uploaded images. Only the Payment and its Refund remain (statutory records).
- An abandoned Registration is never resumed. A fresh sign-in starts a fresh one.

## Routes (the three family choices)

The web's Family step offers three routes (ADR-0020). Two of them **found** a Family and one **joins**:

| Web route | `route` value | Effect |
|---|---|---|
| Just me (default) | `INDIVIDUAL` | Founds a household of one; same minting path |
| Create a new family | `CREATE` | Founds a Family |
| Join an existing family | `JOIN` | Joins by Family ID; waits for the Head |

`INDIVIDUAL` and `CREATE` are stored distinctly (`foundingKind`) only so the success copy can differ; the backend behaviour is identical.

## Models

```prisma
model Registration {
  id               String              @id          // uuid v7
  phoneE164        String
  status           RegistrationStatus  @default(STARTED)
  route            RegistrationRoute?
  joinFamilyId     String?                           // Family.id being joined
  submittedProfile Json?                             // validated SubmitBody minus consents; purged at any end state
  paymentId        String?                           // the captured Registration Payment
  completedMemberId String?
  lastActivityAt   DateTime            @default(now())
  submittedAt      DateTime?
  expiresAt        DateTime?                         // AWAITING_HEAD only
  endedAt          DateTime?
  endReason        String?
  declineReason    String?                           // Head's optional reason, shown to the Applicant
  createdAt        DateTime            @default(now())
  @@index([phoneE164, status])
  @@index([joinFamilyId, status])
  @@index([status, lastActivityAt])
}

enum RegistrationStatus { STARTED PAID AWAITING_HEAD COMPLETED ABANDONED CANCELLED DECLINED EXPIRED }
enum RegistrationRoute  { INDIVIDUAL CREATE JOIN }

model FamilyIdCounter {
  pincode String @id      // six digits
  nextSeq Int             // next SEQ to issue, starts at 1
}

model RomanizationCache {
  textHash  String   @id  // sha256 of NFC-normalized Devanagari input
  latin     String
  createdAt DateTime @default(now())
}
```

Partial unique index (raw SQL): at most one Registration per phone in a live state:

```sql
CREATE UNIQUE INDEX registration_one_live_per_phone
  ON registration (phone_e164) WHERE status IN ('STARTED','PAID','AWAITING_HEAD');
```

## Sign-in integration (`openForPhone`)

Identity calls `registration.openForPhone(tx, phone)` when a phone with no Member signs in:

1. If an `AWAITING_HEAD` Registration exists → return it. The Applicant sees its status and may cancel it; they cannot start another while it waits.
2. If a `STARTED` or `PAID` Registration exists → end it as `ABANDONED` (`endReason: "RESIGNED_IN"`, refund if paid), then create a fresh `STARTED` one.
3. Else create a fresh `STARTED` Registration.

## The Registration Payment

- `POST /v1/registration/payment-order` → `payments.createOrder({ purpose: REGISTRATION, subjectId: registration.id, amountPaise: REGISTRATION_PAYMENT_PAISE, payerPhoneE164 })`. Allowed only in `STARTED`. Returns the checkout payload.
- Worker `payments.captured.REGISTRATION`:
  - Registration in `STARTED` → set `PAID`, `paymentId`, touch `lastActivityAt`.
  - Registration in any other state (it was abandoned while the payment was in flight) → `payments.refund(REGISTRATION_ABANDONED)`.
- Every adult pays — founders and joiners alike (`CONTEXT.md`, Registration Payment). This resolves spec conflict R1.

## Founding (`route: INDIVIDUAL | CREATE`)

**Duplicate check first.** After payment, `GET /v1/registration` reports `founding: { allowed: false, reason: "DUPLICATE_HEAD" }` when the payment's identity hash is already in `HeadAnchor`. The web uses this to steer the Applicant at the Family step: they can still **join** a Family (joiners are never refused on identity), or cancel for a refund. If they do neither, the abandonment job refunds them. This is how "refused and refunded" is realised without refunding a payment the Applicant may still use to join.

Submission, in one transaction (`SELECT … FOR UPDATE` on the Registration):

1. Status must be `PAID`, payment `CAPTURED` and not consumed. Else `409 REGISTRATION_NOT_PAID`.
2. Validate the body (schema below) including `gotra` and the adult check. The phone is the session's phone; the body carries no phone (resolves R5).
3. Identity: `payments.identityOf(paymentId)`.
   - `VPA`/`CARD` with a `HeadAnchor` hit → `409 DUPLICATE_HEAD`. Nothing written.
   - `NONE` → proceed, and raise an Officer flag `NO_PAYMENT_IDENTITY`.
4. Mint the Family ID:
   ```sql
   INSERT INTO family_id_counter (pincode, next_seq) VALUES ($1, 2)
   ON CONFLICT (pincode) DO UPDATE SET next_seq = family_id_counter.next_seq + 1
   RETURNING next_seq - 1 AS seq;
   ```
   `publicId = "AGR-" + pincode + "-" + seq.toString().padStart(5, "0")`. `seq > 99999` → `500` and an operator alert (never wraps). The pincode is the Applicant's address pincode. Gaps appear only on rolled-back transactions; they are harmless and never refilled (invariant 2).
5. `register.createFamilyWithHead(tx, { publicId, pincodeSnapshot, gotra, head: profile, consents, familyPhotoImageId })`.
6. `payments.createHeadAnchor(tx, …)` when identity is `VPA`/`CARD`. A unique violation here (two founders paying from one VPA at the same instant) rolls everything back → `409 DUPLICATE_HEAD`.
7. `payments.markConsumed(tx, paymentId)`.
8. Heuristic flags (never blocking), through `officer.raiseFlag(tx, …)`:
   - `POSSIBLE_DUPLICATE_PERSON` — an ACTIVE or ARCHIVED Member with the same `nameEn` (case-insensitive, trimmed) or `nameHi`, and the same date of birth.
   - `SHARED_ADDRESS` — the Head of a different Family has the same normalized `line1` and pincode.
9. `media.reassign(tx, imageIds, { ownerMemberId, familyId })` for the Member photo and family photo.
10. `identity.promoteToMember(tx, registration.id, memberId)`.
11. Registration → `COMPLETED`, `completedMemberId`, `endedAt`; `submittedProfile = null`.

Response `201`: `{ status: "COMPLETED", memberId, family: { publicId, gotra }, completedAt }`.

## Joining (`route: JOIN`)

Before submission the web checks the Family ID the Applicant typed:

`GET /v1/registration/family-check?familyPublicId=AGR-492001-00017` → `{ exists: boolean, gotra?: Gotra, acceptingJoins?: boolean }`. `acceptingJoins` is false when the Family is archived or already has `JOIN_REQUESTS_PENDING_MAX_PER_FAMILY` pending requests. Rate-limited (`registration.familyCheck`) against enumeration. It never returns names or the Head.

Submission, in one transaction:

1. Status `PAID` (as founding). Family exists, active, under the pending cap. Else `404 FAMILY_NOT_FOUND` / `409 FAMILY_NOT_ACCEPTING_JOINS`.
2. Validate the body. **`gotra` must be absent** — a joiner inherits the Family's Gotra (invariant 4, resolves R2). **`familyPhotoImageId` must be absent** — the family photo is the Family's, set by the Head (resolves R6).
3. Store `submittedProfile`, `route = JOIN`, `joinFamilyId`, status `AWAITING_HEAD`, `submittedAt`, `expiresAt = now + JOIN_REQUEST_EXPIRY_DAYS`. Enqueue `registration.expireJoinRequest` with `startAfter: expiresAt`.
4. Identity flag (never blocking): if the payment's identity hash anchors the Head of a **different** Family → `officer.raiseFlag(JOINER_PAYS_FROM_OTHER_HEAD)`. Paying from the receiving Family's own Head is normal and raises nothing (`CONTEXT.md`, Payment Identity).

Response `202`: `{ status: "AWAITING_HEAD", family: { publicId, gotra }, expiresAt }`.

### The Head's side

| Method | Path | Auth | Effect |
|---|---|---|---|
| GET | `/v1/families/mine/join-requests` | Head | Pending requests for the Head's Family: `{ items: [{ registrationId, name: { en, hi }, fatherOrHusbandName, gender, city, state, submittedAt, expiresAt, flags: [] }] }` |
| POST | `/v1/families/mine/join-requests/:registrationId/approve` | Head | Completes the joiner (below) |
| POST | `/v1/families/mine/join-requests/:registrationId/decline` | Head | `{ reason?: string (≤200) }` → `DECLINED`, refund `JOIN_DECLINED` |

The Head sees the joiner's name, father's/husband's name, gender, city and state — enough to recognise a relative, and exactly what a linked Family would see once they are linked (invariant 22). Date of birth, address and blood group are not shown. Route paths live under `/v1/families` but the handlers are this module's.

**Approve**, in one transaction: status `AWAITING_HEAD` and `joinFamilyId` is the Head's Family (else `404`); Family still active; `register.createMemberInFamily(tx, familyId, profile, consents)`; `payments.markConsumed`; `media.reassign`; `identity.promoteToMember`; status `COMPLETED`; purge `submittedProfile`; `register.onFamilyGainedMember(tx, familyId)` (Nominee prompt, see `register.md`).

Stage 1 has no push notifications. The Head learns of a request by signing in to the website; the joiner learns the outcome by signing in again (their principal is now a Member, or `GET /v1/registration` shows `DECLINED`/`EXPIRED` with the refund state). Stage 2 adds pushes to both (`notifications.md`).

### Applicant's side

| Method | Path | Auth | Effect |
|---|---|---|---|
| GET | `/v1/registration` | Applicant | Current Registration: `{ id, status, route, payment: { status, amountPaise } \| null, founding: { allowed, reason? }, join: { family: { publicId, gotra }, expiresAt, declineReason? } \| null, refund: { status } \| null }` |
| DELETE | `/v1/registration` | Applicant | From `STARTED`/`PAID` → `ABANDONED`; from `AWAITING_HEAD` → `CANCELLED`; refund if paid |

## Submission body (`POST /v1/registration/submit`)

Accepts `Idempotency-Key`. zod schema:

```ts
const BilingualName = z.object({
  en: z.string().trim().min(1).max(120).optional(),   // Latin script only: /^[\p{Script=Latin}\s.'-]+$/u
  hi: z.string().trim().min(1).max(120).optional(),   // Devanagari only:  /^[\p{Script=Devanagari}\s.]+$/u
}).refine(v => v.en || v.hi, "At least one script");

const SubmitBody = z.object({
  route: z.enum(["INDIVIDUAL", "CREATE", "JOIN"]),
  familyPublicId: z.string().regex(/^AGR-[1-9]\d{5}-\d{5}$/).optional(),   // required iff JOIN
  uiLanguage: z.enum(["en", "hi"]),
  typingScript: z.enum(["en", "hi"]),
  name: BilingualName,                 // typingScript "en" → en required; "hi" → hi required
  nameEnConfirmed: z.boolean(),        // true when name.en came from confirming a romanization or was typed
  fatherOrHusbandName: BilingualName,
  gotra: z.enum(GOTRAS).optional(),    // required iff founding; forbidden for JOIN
  gender: z.enum(["FEMALE", "MALE", "OTHER"]),
  dateOfBirth: z.string().date(),      // YYYY-MM-DD; age ≥ 18 on todayIst(); not in the future
  bloodGroup: z.enum(["A_POS","A_NEG","B_POS","B_NEG","AB_POS","AB_NEG","O_POS","O_NEG"]),
  address: z.object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(80),
    state: z.enum(INDIAN_STATES_AND_UTS),   // all 28 states + 8 UTs
    pincode: z.string().regex(/^[1-9]\d{5}$/),
  }),
  nativePlace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("LISTED"), id: z.enum(NATIVE_PLACE_IDS) }),
    z.object({ kind: z.literal("OTHER"), text: z.string().trim().min(1).max(120) }),
    z.object({ kind: z.literal("UNKNOWN") }),
  ]),
  kuldevi: z.string().trim().max(80).optional(),
  kuldevta: z.string().trim().max(80).optional(),
  photoImageId: z.string().uuid().optional(),
  familyPhotoImageId: z.string().uuid().optional(),   // founding only
  consents: z.object({
    directoryListing: z.literal(true),                // listing is membership
    bloodGroupMatching: z.boolean(),
    photoVisible: z.boolean(),
  }),
  paymentRetentionDisclosureAcknowledged: z.literal(true),
});
```

- `GOTRAS`: the eighteen, as `GARG, GOYAL, GOYAN, BANSAL, KANSAL, SINGHAL, JINDAL, TINGAL, MOHAN, DHARAN, MADHUKUL, BINDAL, MITTAL, TAYAL, MANGAL, AIRAN, NANGAL, KUCHHAL`, with their Devanagari labels from `Agrawal_Frontend/prototypes/registration/src/data/constants.js`.
- `NATIVE_PLACE_IDS`: slugs of the fourteen places in the same file (`AGROHA_HARYANA`, …). Seed a `NativePlace(id, labelEn, labelHi)` table from it.
- `INDIAN_STATES_AND_UTS`: the prototype lists only 22 states; the API accepts all 36 states and union territories. The web's select must be widened to match.
- Image IDs must reference images uploaded by this Registration (`media.ownedByRegistration`), else `422 IMAGE_NOT_OWNED`.
- Kuldevi, Kuldevta and native-place free text are stored as typed, in whichever script, and are Member-only (invariant 22).

### Names (invariant 21)

- `typingScript: "en"` → `name.en` required; `name.hi` stays empty unless the Member typed it. Nothing fills Devanagari.
- `typingScript: "hi"` → `name.hi` required. Before submission the web calls `POST /v1/romanize { text }` → `{ latin }` and offers it for confirmation. If the Member confirms (optionally editing), the body carries `name.en` and `nameEnConfirmed: true`. If they decline, `name.en` is absent; at submission the server romanizes `name.hi` itself and stores the result **only** as `nameEnSearchKey`. The client never supplies the search key.
- Same rule for `fatherOrHusbandName`.
- `POST /v1/romanize`: principal auth; body `{ text: string }` (Devanagari, ≤120 chars); response `{ latin: string }`; cached in `RomanizationCache`; `503 UPSTREAM_UNAVAILABLE` if Google is down — the web then lets the Member type Latin or continue without it.

## Jobs

| Job | Trigger | Effect |
|---|---|---|
| `registration.expireJoinRequest` | `startAfter: expiresAt` | If still `AWAITING_HEAD` and `expiresAt ≤ now` → `EXPIRED`, refund `JOIN_EXPIRED`, purge. |
| `registration.expireJoinRequests` | hourly cron | Backstop for the above. |
| `registration.abandonIdle` | every 15 min | `STARTED`/`PAID` with `lastActivityAt` older than `REGISTRATION_ABANDON_AFTER_HOURS` → `ABANDONED`, refund if paid, purge. |
| `payments.captured.REGISTRATION` | from Payments | See "The Registration Payment". |

Purging an ended Registration: `submittedProfile = null`; `media.deleteOwnedByRegistration(tx, id)`. `lastActivityAt` is touched by every Applicant request on `/v1/registration*`, `/v1/romanize` and `/v1/media/images`.

## Error codes

`REGISTRATION_NOT_FOUND` 404, `REGISTRATION_WRONG_STATE` 409, `REGISTRATION_NOT_PAID` 409, `DUPLICATE_HEAD` 409, `FAMILY_NOT_FOUND` 404, `FAMILY_NOT_ACCEPTING_JOINS` 409, `NOT_ADULT` 422, `GOTRA_NOT_ALLOWED_FOR_JOIN` 422, `GOTRA_REQUIRED` 422, `IMAGE_NOT_OWNED` 422.

## What the web must change from the prototype

The prototype (`Agrawal_Frontend/prototypes/registration/`) is the UI reference, not the contract (`docs/spec/registration.md` §12–13):

- The Family step no longer shows a minted ID before submission: founding shows the preview `AGR-<pincode>-XXXXX`; the real ID appears on the success screen. Joining shows the Family's Gotra from `family-check`.
- The Personal step drops the editable second mobile number (R5) and, for a joiner, the Gotra select (R2).
- The family photo uploader appears only on founding routes (R6).
- Nominee leaves the Profile step: a founder has no other Member to name, and a joiner is not a Member yet. It is set later through `/v1/me/nominee` (R7, ADR-0018).
- Success for `JOIN` reads "waiting for your Head of Family", not "Registration Complete".
- The Family ID error copy says 16 characters, `AGR-XXXXXX-XXXXX` (R10).
- The payment copy's purpose line is friction, not revenue (R11).

## Public interface (`index.ts`)

```ts
openForPhone(tx, phoneE164: string): Promise<{ registrationId: string }>
```

## Required tests

- invariant 1: a founding submit before the payment is captured → `REGISTRATION_NOT_PAID`, no Family row.
- invariant 2: two concurrent foundings in pincode 492001 get `-00001` and `-00002`; no path updates `publicId`.
- invariant 6: founding paid from a VPA already in `HeadAnchor` → `DUPLICATE_HEAD`; the same Registration can then `JOIN` successfully; if instead abandoned, it is refunded once.
- Founding with identity `NONE` succeeds and raises `NO_PAYMENT_IDENTITY`.
- invariant 7: DOB making the Applicant 17 years 364 days old on today's IST date → `NOT_ADULT`; exactly 18 today → accepted.
- invariant 8: a joiner is not a Member until approval; `GET /v1/directory` (Stage 2) and the Family's member list omit them; only the Head of that Family can approve (another Member → 403; another Family's Head → 404).
- Joiner with `gotra` → `GOTRA_NOT_ALLOWED_FOR_JOIN`; approved joiner's Gotra equals the Family's.
- Decline → `DECLINED`, one refund, profile purged, images deleted.
- Expiry at 14 days (fake clock) → `EXPIRED`, one refund.
- Re-sign-in with a `PAID` Registration → old one `ABANDONED` and refunded, new one `STARTED`.
- Re-sign-in with an `AWAITING_HEAD` Registration → the same Registration returned.
- A payment captured after its Registration was abandoned → refunded.
- Joiner paying from another Family's Head's VPA → flag raised, join proceeds.
- invariant 21: Hindi-typed name without confirmation → `nameHi` set, `nameEn` null, `nameEnSearchKey` set.
- Submit replayed with the same `Idempotency-Key` → same response, one Member.
