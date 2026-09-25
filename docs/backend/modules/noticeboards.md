# Module: Noticeboards

Owns authored Notices: Shok Sandesh (Stage 2), Business Listings (Stage 2), Archival Requests, Reports, suspensions, the daily posting cap and the automated text check. The Jobs board and Announcements board are Stage 3 and not built in this plan.

Read `CONTEXT.md` → Notice, Commercial Notice, Posting Fee, Business Listing, Shok Sandesh, Archival, Archival Request, Report, invariants 10, 12, 13, 14 first.

## Models

```prisma
model Notice {
  id               String        @id                  // uuid v7
  board            NoticeBoard
  authorMemberId   String
  authorFamilyId   String                             // denormalized; used by Reports
  status           NoticeStatus  @default(ACTIVE)
  title            String?                            // Business Listing: name; Shok Sandesh: optional
  bodyHi           String?
  bodyEn           String?
  linkedMemberId   String?                            // Shok Sandesh: the deceased Member, if known
  imageId          String?                            // via Media module
  metadata         Json?                              // board-specific fields (see below)
  paymentId        String?                            // Commercial Notices only
  publishedAt      DateTime?
  expiresAt        DateTime?                          // Business Listing: publishedAt + 180 days
  hiddenAt         DateTime?                          // Report threshold reached
  hiddenReason     String?                            // REPORTS | OFFICER
  createdAt        DateTime      @default(now())
  reports          Report[]
  @@index([board, status, publishedAt])
  @@index([authorMemberId])
  @@index([authorFamilyId])
  @@index([linkedMemberId])
}

enum NoticeBoard  { SHOK_SANDESH BUSINESS_LISTING }
enum NoticeStatus { DRAFT ACTIVE HIDDEN EXPIRED REMOVED }
// DRAFT: Business Listing awaiting payment; ACTIVE: published; HIDDEN: by Reports or Officer;
// EXPIRED: past expiresAt; REMOVED: Erasure or Officer

model BusinessListingMeta {
  noticeId         String   @id                       // = Notice.id
  category         String                             // from BUSINESS_CATEGORIES
  businessCity     String
  businessCityKey  String                             // lower(trim(unaccent(businessCity)))
  businessPhone    String                             // the business's own number — deliberately public
  businessAddress  String?
  @@index([category, businessCityKey])
}

model ArchivalRequest {
  id               String               @id
  noticeMemberId   String?                            // Shok Sandesh author; null if Officer-opened
  deceasedMemberId String                             // the Member whose death is asserted
  familyId         String                             // the deceased's Family
  status           ArchivalRequestStatus @default(OPEN)
  createdAt        DateTime             @default(now())
  respondedAt      DateTime?
  respondedBy      String?                            // memberId of the Family confirmer, or "OFFICER:<id>"
  escalatedAt      DateTime?
  expiresAt        DateTime                           // createdAt + ARCHIVAL_ESCALATION_DAYS
  @@index([deceasedMemberId])
  @@index([status, expiresAt])
  // at most one unresolved per deceased: partial unique index in raw SQL,
  //   CREATE UNIQUE INDEX archival_request_one_open ON archival_request (deceased_member_id)
  //     WHERE status IN ('OPEN','ESCALATED');
  // never @@unique([deceasedMemberId, status]), which would forbid a second REFUTED request.
}

enum ArchivalRequestStatus { OPEN CONFIRMED REFUTED ESCALATED }

model Report {
  id               String   @id
  targetType       String                             // NOTICE | BLOOD_SOS
  targetId         String                             // noticeId or Blood SOS id
  noticeId         String?                            // non-null only when targetType = NOTICE
  notice           Notice?  @relation(fields: [noticeId], references: [id])
  reporterMemberId String
  reporterFamilyId String                             // denormalized for distinct-family count
  reason           String                             // free text ≤ 300
  createdAt        DateTime @default(now())
  @@unique([targetId, reporterMemberId])              // one report per Member per target
  @@index([targetId, reporterFamilyId])
}

model Suspension {
  id               String   @id
  memberId         String
  reason           String                             // REPORTS
  activeNoticeId   String?                            // the Notice that triggered it
  startsAt         DateTime @default(now())
  endsAt           DateTime                           // startsAt + SUSPENSION_DURATION_DAYS
  liftedAt         DateTime?
  liftedBy         String?                            // Officer memberId
  liftedReason     String?
  @@index([memberId, endsAt])
}
```

### Business Listing metadata (`Notice.metadata`)

The `metadata` JSON on a `BUSINESS_LISTING` Notice is **not** the authoritative store; `BusinessListingMeta` is. `metadata` holds a snapshot for display convenience only; queries filter on `BusinessListingMeta` columns.

### Archival Request lifecycle

```
Shok Sandesh linked to a Member
       │
     OPEN ───────────── expiresAt passes ──► ESCALATED (Officer task)
       │                                         │
  Family confirms    Family refutes       Officer resolves
       │                │                   ┌────┴────┐
   CONFIRMED          REFUTED          CONFIRMED   REFUTED
  (archiveMember)                     (archiveMember)
```

- `CONFIRMED` calls `register.archiveMember(tx, deceasedMemberId, confirmedBy)`.
- `REFUTED` leaves the Member unchanged. The Shok Sandesh stays published (the announcement stands; the archival does not).
- `ESCALATED` appears in the Officer's task queue (`/v1/officer/archival-requests?status=ESCALATED`).

## Configuration defaults

| Variable | Default | Notes |
|---|---|---|
| `POSTING_CAP_PER_DAY` | `3` | Per IST calendar day per Member; Blood SOS exempt |
| `REPORTS_THRESHOLD` | `5` | Distinct Families required to auto-hide |
| `SUSPENSION_DURATION_DAYS` | `7` | |
| `ARCHIVAL_ESCALATION_DAYS` | `7` | Days before an unresolved Archival Request escalates to the Officer |
| `BUSINESS_LISTING_DURATION_DAYS` | `180` | |
| `BLOCKED_WORDS` | `[]` | JSON array; loaded at boot, reloadable via config |
| `PHONE_REGEX_IN_TEXT` | `(?:\+91[\s-]?)?[6-9]\d{9}` | Indian mobile numbers in Notice text |

All values live in config, never as literals in code.

## Rules

### Daily posting cap (invariant — no number in CONTEXT.md)

A Member's Notice count for today's IST calendar day (`clock.todayIst()`) across all boards. If `≥ POSTING_CAP_PER_DAY` → `429 POSTING_CAP_REACHED`. Blood SOS is exempt (different module). The service locks the Member row, checks the count and creates the Notice in the same transaction, so concurrent posts cannot exceed the cap.

### Automated text check

Before publishing any Notice, check the combined text (`title + bodyEn + bodyHi`):

1. **Blocked words** — case-insensitive, whole-word match against `BLOCKED_WORDS`. Hit → `422 NOTICE_CONTAINS_BLOCKED_WORD`.
2. **Personal phone numbers** — match `PHONE_REGEX_IN_TEXT` in the text. Hit → `422 NOTICE_CONTAINS_PHONE`. **Exception**: a `BUSINESS_LISTING` is exempt because the business phone is a deliberate public fact and is entered in a structured field, not in free text. The check still runs on a Business Listing's title and description to prevent the *Member's* personal number from appearing there.

### Reports (invariants 13, 14)

`POST /v1/notices/:id/report` `{ reason }`:

1. The reporter is a Member. The author's own Family cannot report their own Notice (`reporterFamilyId ≠ authorFamilyId`; else `422 CANNOT_REPORT_OWN`).
2. Insert `Report`; on unique violation (`targetId + reporterMemberId`) → `409 ALREADY_REPORTED`.
3. Count distinct `reporterFamilyId` on this Notice where `reporterFamilyId ≠ authorFamilyId`. If `≥ REPORTS_THRESHOLD`:
   - Notice → `HIDDEN`, `hiddenAt`, `hiddenReason = REPORTS`.
   - Create `Suspension` for the author: `endsAt = now + SUSPENSION_DURATION_DAYS`.
   - After commit, launch the independent `NOTICE_HIDDEN` and `SUSPENSION` notifications concurrently (at most two sends). Wait for both to settle, then propagate a send failure; the Notice hide and Suspension remain committed.

A suspended Member's existing Notices stay visible (they were already posted); the suspension blocks new posts: `POST /v1/notices` checks for an active `Suspension` and returns `403 POSTING_SUSPENDED` with `endsAt`.

Blood SOS Reports: `Report` rows with `targetType = BLOOD_SOS` are stored but never trigger auto-hiding or suspension. They appear in the Officer's queue (`/v1/officer/reports?target=BLOOD_SOS`). The Officer may close the Blood SOS request if abusive.

### Shok Sandesh

A Shok Sandesh is a Notice on the `SHOK_SANDESH` board. It publishes immediately on submission.

A Shok Sandesh has **no contact-phone field**, and its text goes through the same phone check as any Notice. A "condolences" number would show a Member's phone to the whole Samaj, which breaks invariant 16. Condolences reach the family through their Family Chat once chat ships (Stage 3), not through the Notice.

If `linkedMemberId` is supplied and that Member is ACTIVE:
- Open an `ArchivalRequest` for the deceased.
- After the Notice and Archival Request commit, send `notifications.send(adultMembersOfFamily(familyId, exceptMemberId: authorMemberId), { topic: ARCHIVAL_REQUEST, … })`. The linked Member is among the recipients. If they are alive, they are the person best placed to refute.
- The Archival Request is **not** confirmation of death; it is the question.

If `linkedMemberId` is null → no Archival Request is opened; the Shok Sandesh is purely an announcement (CONTEXT.md, Archival Request).

A Shok Sandesh may optionally carry an image (`SHOK_SANDESH_PHOTO` purpose via Media). A Business Listing photo is `BUSINESS_PHOTO`. Both follow `media.md`: until screening is on, the image is shown to its uploader only and every other reader gets `imageUrl: null` (invariant 11). Notices must not bypass Media's visibility check to show a photo to the board.

When Media removes an attached `SHOK_SANDESH_PHOTO` or `BUSINESS_PHOTO`, Noticeboards clears matching `Notice.imageId` references through its `onImageRemoved` handler in the same transaction. A handler failure propagates and prevents the image removal from committing.

### Archival Request confirmation

`POST /v1/archival-requests/:id/confirm` — auth: any Member of the deceased's Family other than the deceased. That includes the Shok Sandesh's author if they belong to that Family (invariant 10 asks for family confirmation, not a second person). Every Member is an adult (invariant 7). Else `403 NOT_FAMILY_MEMBER`.

In one transaction:
1. Status `OPEN` or `ESCALATED` and `respondedBy` is null; else `409`.
2. `register.archiveMember(tx, deceasedMemberId, { kind: 'MEMBER', memberId })`.
3. Request → `CONFIRMED`, `respondedAt`, `respondedBy`.
4. Processing Record `MEMBER_ARCHIVED`.

`POST /v1/archival-requests/:id/refute` — auth: any Member of the deceased's Family, **including the linked Member themselves**. Sets `REFUTED`. Member unchanged. No Processing Record beyond the Officer's future inspection.

### Business Listing (invariant 12)

A Business Listing is a Commercial Notice. It publishes only after its Posting Fee completes.

If `BUSINESS_LISTING_FEE_PAISE` is unset, the board doesn't open. Every Business Listing route returns `503 BOARD_NOT_OPEN`, including the browse route, and the app shows the board as not yet open (invariant 12). Setting the variable to empty is how the Operator closes the board.

**Creation flow:**

1. `POST /v1/business-listings` → creates a `DRAFT` Notice + `BusinessListingMeta`. Returns `{ noticeId }`.
2. `POST /v1/business-listings/:id/payment-order` → `payments.createOrder({ purpose: BUSINESS_LISTING, subjectId: noticeId, amountPaise: BUSINESS_LISTING_FEE_PAISE, payerMemberId })`.
3. Worker `payments.captured.BUSINESS_LISTING`:
   - Notice `DRAFT` → `ACTIVE`, `publishedAt = now`, `expiresAt = now + BUSINESS_LISTING_DURATION_DAYS`.
   - Payment → consumed.
   - Notice in any other state (abandoned) → `payments.refund(PUBLICATION_FAILED)`.
4. After a refund is processed, `payments.refunded.BUSINESS_LISTING` marks the Payment consumed so reconciliation does not replay its captured event.

**Renewal:**

`POST /v1/business-listings/:id/renew` — a fresh payment order on the same Notice. On capture: extend `expiresAt` by another `BUSINESS_LISTING_DURATION_DAYS` from the current `expiresAt` (or from now, whichever is later). Each renewal is charged the current `BUSINESS_LISTING_FEE_PAISE`. The amount is Operator config and never a literal (ADR-0008).

**Expiry:**

`noticeboards.expireListings` (hourly): Notices with `board = BUSINESS_LISTING`, `status = ACTIVE`, `expiresAt ≤ now` → `EXPIRED`. The author may renew an expired listing without re-entering data.

**Browse:**

`GET /v1/business-listings?category=&city=&q=&cursor=` — public to all Members. Returns the Notice projected through `register.project` for the author's identity (SAMAJ projection of the author), plus the `BusinessListingMeta` fields which are all public by design.

**No cap on listings** — a Member may hold as many as they pay for (ADR-0019); each creation consumes the daily posting cap.

### Officer actions (routed through Officer module)

- **Lift suspension**: `Suspension.liftedAt`, `liftedBy`, `liftedReason`; optionally restore the hidden Notice → `ACTIVE` (invariant 18). Processing Record `SUSPENSION_LIFTED` and optionally `NOTICE_RESTORED`.
- **Restore a hidden Notice** without lifting the suspension: the Notice moves to `ACTIVE`; the author stays suspended. Processing Record `NOTICE_RESTORED`.
- **Resolve an escalated Archival Request**: `CONFIRM` (archives the Member) or `REFUTE` (leaves them active). Processing Record `ARCHIVAL_RESOLVED_BY_OFFICER`.

## Erasure hooks (registered with `register.onMemberErased`)

- Their Shok Sandesh Notices: author fields scrubbed, text retained as Historical Content, author shown as "a former member".
- Their Business Listings: deleted (status `REMOVED`).
- Reports they filed: deleted.
- Their Suspensions: lifted/deleted.

## Endpoints

| Method | Path | Auth | Stage | Notes |
|---|---|---|---|---|
| POST | `/v1/notices` | member | 2 | `{ board: "SHOK_SANDESH", linkedMemberId?, title?, bodyHi?, bodyEn?, imageId? }` → published immediately; text check; posting cap |
| GET | `/v1/notices?board=SHOK_SANDESH&cursor=` | member | 2 | Newest first; author as SAMAJ projection; `HIDDEN` Notices absent |
| GET | `/v1/notices/:id` | member | 2 | Single Notice |
| POST | `/v1/notices/:id/report` | member | 2 | `{ reason }` |
| POST | `/v1/business-listings` | member | 2 | `{ name, category, businessCity, businessPhone, businessAddress?, bodyHi?, bodyEn?, imageId? }` → DRAFT |
| POST | `/v1/business-listings/:id/payment-order` | member (author) | 2 | Checkout payload |
| POST | `/v1/business-listings/:id/renew` | member (author) | 2 | New payment order on an ACTIVE or EXPIRED listing |
| GET | `/v1/business-listings` | member | 2 | Browse + search; filters: `category`, `city` (via `businessCityKey`), `q` (trigram on `name`); cursor-paginated |
| GET | `/v1/business-listings/:id` | member | 2 | Single listing |
| DELETE | `/v1/business-listings/:id` | member (author) | 2 | Author removes their own listing → `REMOVED`; no refund |
| GET | `/v1/business-listings/mine` | member | 2 | Author's own listings (all statuses) |
| GET | `/v1/archival-requests/mine` | member | 2 | Archival Requests for the Member's Family's Members |
| POST | `/v1/archival-requests/:id/confirm` | member (family) | 2 | Confirm death; archives the Member |
| POST | `/v1/archival-requests/:id/refute` | member (family) | 2 | Refute death; no change |
| GET | `/v1/me/suspension` | member | 2 | Active suspension if any: `{ endsAt, reason, noticeId }` or `null` |

### Submission schemas

```ts
const ShokSandeshBody = z.object({
  board: z.literal("SHOK_SANDESH"),
  linkedMemberId: z.string().uuid().optional(),
  title: z.string().trim().max(200).optional(),
  bodyHi: z.string().trim().max(2000).optional(),
  bodyEn: z.string().trim().max(2000).optional(),
  imageId: z.string().uuid().optional(),
}).strict().refine(v => v.bodyHi || v.bodyEn, "At least one body script");

const BusinessListingBody = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(BUSINESS_CATEGORIES),
  businessCity: z.string().trim().min(1).max(80),
  businessPhone: z.string().regex(/^\+?[0-9\s-]{7,15}$/),
  businessAddress: z.string().trim().max(300).optional(),
  bodyHi: z.string().trim().max(2000).optional(),
  bodyEn: z.string().trim().max(2000).optional(),
  imageId: z.string().uuid().optional(),
});
```

`BUSINESS_CATEGORIES`: a fixed enum seeded from the Flutter prototype's categories list. Added to config as a reference table, not hard-coded.

## Jobs

| Job | Schedule | Effect |
|---|---|---|
| `noticeboards.expireListings` | hourly | ACTIVE Business Listings past `expiresAt` → `EXPIRED` |
| `noticeboards.endSuspensions` | every 15 min | Suspensions past `endsAt` without `liftedAt` → set `liftedAt = endsAt`, `liftedReason = EXPIRED` |
| `noticeboards.escalateArchivals` | hourly | OPEN Archival Requests past `expiresAt` → `ESCALATED` |
| `payments.captured.BUSINESS_LISTING` | from Payments | Publish the listing (see Business Listing flow) |
| `payments.refunded.BUSINESS_LISTING` | after a processed refund | Mark the Payment consumed and stop captured-event recovery |

## Rate limits

| Name | Key | Limit |
|---|---|---|
| `notice.create` | memberId | 10 / hour |
| `notice.report` | memberId | 30 / hour |
| `businessListing.create` | memberId | 10 / hour |

## Public interface (`index.ts`)

```ts
onMemberErased(handler): void     // registered with register.onMemberErased at boot
activeSuspension(memberId: string): Promise<Suspension | null>
archivalRequestsForMember(memberId: string): Promise<ArchivalRequest[]>
handleImageRemoved(tx, imageId): Promise<void> // detach matching Notice.imageId references
```

## Required tests

- invariant 10: a Shok Sandesh linked to a Member does not change the Member's status; only `confirm` does.
- invariant 12: a Business Listing in `DRAFT` is not visible in `GET /v1/business-listings`; it becomes `ACTIVE` only after `payments.captured.BUSINESS_LISTING` runs.
- invariant 13: four reports from four different Families → Notice stays `ACTIVE`; a fifth from a fifth Family → `HIDDEN`.
- invariant 13: two reports from the same Family (different Members) count as one distinct Family.
- invariant 13: a report from the author's own Family → `CANNOT_REPORT_OWN`.
- invariant 14: when a Notice is hidden, the author receives a push with `topic: SUSPENSION`; `GET /v1/me/suspension` returns the active suspension with `endsAt`; the suspension ends automatically after `SUSPENSION_DURATION_DAYS` (fake clock).
- Text check: a Shok Sandesh with `9812345678` in the body → `NOTICE_CONTAINS_PHONE`; a Business Listing with a phone in `businessPhone` field → accepted; a Business Listing with a phone in `bodyEn` → `NOTICE_CONTAINS_PHONE`.
- Archival Request: linked Shok Sandesh → request OPEN; family confirms → Member ARCHIVED, Head succeeded; family refutes → Member unchanged.
- Archival escalation: OPEN request past `expiresAt` (fake clock) → `ESCALATED`.
- Business Listing expires after 180 days (fake clock) → `EXPIRED`; renewal extends by another 180 days.
- Erasure: author erased → Shok Sandesh text retained with author "a former member"; Business Listings `REMOVED`; Reports filed by them deleted; Suspension lifted.
- A suspended Member creating a Notice → `403 POSTING_SUSPENDED`.
- Posting cap: 3 Notices on the same IST day → `429 POSTING_CAP_REACHED`; the 4th fails.
- Blood SOS report (targetType BLOOD_SOS): no auto-hiding, no suspension; appears in Officer queue.
- invariant 16: `ShokSandeshBody` has no phone field; a `contactPhone` key in the body is rejected by the strict schema.
- invariant 11: with screening off, a Shok Sandesh or Business Listing photo has a URL for its author and `null` for every other Member.
- Media image removal clears only matching Shok Sandesh and Business Listing image references.
- invariant 12: with `BUSINESS_LISTING_FEE_PAISE` unset, `POST /v1/business-listings` → `503 BOARD_NOT_OPEN`.
- Archival Request: the linked Member refutes their own Archival Request → `REFUTED`; they cannot confirm it (`403`). After a `REFUTED` request, a new linked Shok Sandesh can open a fresh one.

## What the Flutter app must change

- **Shok Sandesh `contactPhone`** (`notices/domain/models/shok_sandesh_notice.dart`, the compose page's contact field, and the "Condolences:" line on the detail page) is removed. The API has no such field and would refuse a phone number in the body anyway (invariant 16).

Module error codes: `BOARD_NOT_OPEN` 503, `POSTING_CAP_REACHED` 429, `POSTING_SUSPENDED` 403, `NOTICE_CONTAINS_PHONE` 422, `NOTICE_CONTAINS_BLOCKED_WORD` 422, `CANNOT_REPORT_OWN` 422, `ALREADY_REPORTED` 409, `NOTICE_NOT_FOUND` 404, `LISTING_NOT_FOUND` 404, `ARCHIVAL_REQUEST_NOT_FOUND` 404, `ARCHIVAL_REQUEST_ALREADY_RESOLVED` 409, `NOT_FAMILY_MEMBER` 403.
