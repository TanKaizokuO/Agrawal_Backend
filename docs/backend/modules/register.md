# Module: Register

Owns the register itself: Families, Members, Family Links, profiles, Consent Toggles, the Nominee, **visibility projections**, the directory, Head succession, Archival state and Erasure. Stage 1 for the model, `/v1/me` and Officer-executed Erasure; Stage 2 for the directory, invites, self-service Erasure and Archival.

Read `CONTEXT.md` → Membership, Governance and privacy, and invariants 3, 4, 5, 9, 16, 17, 20, 21, 22, 24, 25 first.

## Models

```prisma
model Family {
  id              String        @id                  // uuid v7
  publicId        String        @unique              // AGR-492001-00017; never updated
  gotra           Gotra                              // never updated
  pincodeSnapshot String                             // the pincode that minted publicId
  headMemberId    String?       @unique              // non-null while ACTIVE
  status          FamilyStatus  @default(ACTIVE)
  photoImageId    String?
  createdAt       DateTime      @default(now())
  archivedAt      DateTime?
  links           FamilyLink[]
}

enum FamilyStatus { ACTIVE ARCHIVED }

model Member {
  id                    String       @id           // uuid v7
  phoneE164             String       @unique       // invariant 25 (ACTIVE and ARCHIVED alike)
  status                MemberStatus @default(ACTIVE)
  nameEn                String?                    // typed or confirmed Latin — displayable
  nameHi                String?                    // typed Devanagari — displayable
  nameEnSearchKey       String?                    // machine romanization — search only, never returned
  fatherNameEn          String?
  fatherNameHi          String?
  fatherNameEnSearchKey String?
  gender                Gender
  dateOfBirth           DateTime     @db.Date
  bloodGroup            BloodGroup
  addressLine1          String
  addressLine2          String?
  city                  String
  cityKey               String                     // lower(trim(unaccent(city))) for matching
  district              String?                    // from the pincode lookup; null if lookup failed
  state                 IndianState
  pincode               String
  nativePlaceKind       NativePlaceKind            // LISTED | OTHER | UNKNOWN
  nativePlaceId         String?
  nativePlaceText       String?
  kuldevi               String?
  kuldevta              String?
  photoImageId          String?
  nomineeMemberId       String?
  nomineePromptPending  Boolean      @default(false)
  consentDirectory      Boolean      @default(true) // always true while the Member exists
  consentBloodGroup     Boolean
  consentPhoto          Boolean
  paymentDisclosureAckAt DateTime
  uiLanguage            String       @default("en")
  createdAt             DateTime     @default(now())
  archivedAt            DateTime?
  archivedBy            String?                    // memberId of the confirmer, or "OFFICER:<id>"
  link                  FamilyLink?
  @@index([status, cityKey])
  @@index([status, state, district])
}

enum MemberStatus    { ACTIVE ARCHIVED }
enum Gender          { FEMALE MALE OTHER }
enum BloodGroup      { A_POS A_NEG B_POS B_NEG AB_POS AB_NEG O_POS O_NEG }
enum NativePlaceKind { LISTED OTHER UNKNOWN }
enum Gotra { GARG GOYAL GOYAN BANSAL KANSAL SINGHAL JINDAL TINGAL MOHAN DHARAN MADHUKUL BINDAL MITTAL TAYAL MANGAL AIRAN NANGAL KUCHHAL }
// enum IndianState: all 28 states and 8 union territories, SCREAMING_SNAKE_CASE

model FamilyLink {
  memberId  String    @id                 // invariant 3: one link per Member
  member    Member    @relation(fields: [memberId], references: [id])
  familyId  String
  family    Family    @relation(fields: [familyId], references: [id])
  kind      LinkKind  @default(BIRTH)
  createdAt DateTime  @default(now())
  @@index([familyId])
}

enum LinkKind { BIRTH }          // MARITAL is Post-Stage 3

model ConsentEvent {
  id        String        @id
  memberId  String
  toggle    ConsentToggle
  value     Boolean
  source    String        // REGISTRATION | MEMBER | ERASURE
  at        DateTime      @default(now())
  @@index([memberId])
}

enum ConsentToggle { DIRECTORY BLOOD_GROUP PHOTO PAYMENT_DISCLOSURE_ACK }

model ErasureRequest {
  id          String   @id
  memberId    String
  source      String   // MEMBER (Stage 1 request) | DIRECTORY_WITHDRAWAL | OFFICER
  status      String   // PENDING | EXECUTED | WITHDRAWN
  requestedAt DateTime @default(now())
  executedAt  DateTime?
  executedBy  String?  // memberId of Officer, or "SELF"
}

model OfficerMessage {           // how the Officer "tells the Member why" without push (Stage 1)
  id        String   @id
  memberId  String
  kind      String   // IMAGE_REMOVED | SUSPENSION_LIFTED | …
  reason    String
  createdAt DateTime @default(now())
  readAt    DateTime?
  @@index([memberId])
}

model Invite {                   // Stage 2
  code        String   @id       // 10 chars, Crockford base32
  familyId    String
  createdBy   String             // memberId
  createdAt   DateTime @default(now())
  expiresAt   DateTime           // +14 days
}

model PincodeCache {
  pincode   String   @id
  district  String
  state     String
  fetchedAt DateTime @default(now())
}
```

Raw SQL: `CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent;` and GIN trigram indexes on `member.name_en`, `member.name_hi`, `member.name_en_search_key`, `member.city_key`.

### Restricted storage

A Postgres schema `restricted` (Prisma `multiSchema`) holding rows moved out of the live tables on Erasure, each with `retainUntil`:

- `restricted.payment`, `restricted.refund` — copies of the erased Member's Payments and Refunds (`retainUntil = erasedAt + RETENTION_DAYS_PAYMENTS`).
- `restricted.consent_event` — their consent history (`+ RETENTION_DAYS_CONSENT_AND_LOGS`).
- `restricted.member_tombstone(member_id, erased_at, retain_until)` — the erased ID, so the moved rows can be tied together.

The app role can `INSERT` into `restricted.*` and nothing else; `register.purgeRestricted` deletes expired rows through the owner-owned `SECURITY DEFINER` function `restricted.purge_expired()`, which the app role may only `EXECUTE`. The Processing Record already carries `retain_until` from its insert and is not moved.

## Visibility projections (the single place invariants 16, 20 and 22 live)

`register.project(viewer, memberIds)` returns, per Member, exactly the fields the viewer's **relation** allows. Every endpoint that shows a Member — in any module — goes through it.

Relation, computed per (viewer, subject):
- `SELF` — same Member.
- `FAMILY` — both hold a Family Link to the same Family.
- `SAMAJ` — any other signed-in Member.
- (`FRIEND` is Post-this-plan, ADR-0021; do not build.)

| Field | SAMAJ | FAMILY | SELF |
|---|---|---|---|
| `memberId`, `familyPublicId`, `isHead` | ✓ | ✓ | ✓ |
| `name` (display rule below) | ✓ | ✓ | ✓ |
| `gotra` (the Family's) | ✓ | ✓ | ✓ |
| `city`, `state` | ✓ | ✓ | ✓ |
| `photoUrl` (rule below) | ✓ | ✓ | ✓ |
| `phoneE164` | | ✓ | ✓ |
| `fatherOrHusbandName` | | ✓ | ✓ |
| `gender`, `dateOfBirth`, `address` (line1, line2, pincode, district), `nativePlace`, `kuldevi`, `kuldevta`, `nominee`, consents | | | ✓ |
| `bloodGroup` | | | ✓ (own record only, for editing) |

- Fields are **allow-listed** per relation; a field added to `Member` appears nowhere until added to this table by a decision (invariant 22's closed default).
- **Name display**: return `{ en, hi }` where `en` is `nameEn` (never `nameEnSearchKey`) and `hi` is `nameHi`. Clients show the script the Member supplied: `en` if present in the English UI, else `hi`; `hi` if present in the Hindi UI, else `en`. A Hindi-only Member shows in Devanagari in both UIs (invariant 21).
- **Photo**: `photoUrl` is a presigned URL when `consentPhoto` is true **and** `media.isVisibleToOthers(photoImageId)` (i.e. screened and approved). While screening is off, others get `null` and SELF gets the URL with `photoStatus: "UNSCREENED"` (invariant 11 as rewritten).
- Media removal events for `MEMBER_PHOTO` and `FAMILY_PHOTO` clear only the matching Register-owned `photoImageId` reference in the same transaction. Media emits the event and does not directly update Member or Family rows.
- Business Listings are public at SAMAJ, but they live in Noticeboards; clients fetch them with `GET /v1/business-listings?ownerMemberId=`.
- Archived Members project to SAMAJ/FAMILY viewers only through Shok Sandesh and history surfaces, as `{ memberId, name, gotra, deceased: true }`.

Family photo: not named in invariant 22, so it is visible to the Family's own Members only (closed default) *(open — see `open-questions.md`)*.

## Rules

- **Creating Members** (called by Registration only): `createFamilyWithHead` and `createMemberInFamily` write the Member, its Family Link, the ConsentEvents for each toggle and the disclosure acknowledgement, look up the district (`PincodeDirectory.lookup`, via `PincodeCache`; on failure leave `district` null and enqueue `register.fillDistrict`), compute `cityKey`, and store names per invariant 21. `phoneE164` unique violation → `409 PHONE_ALREADY_REGISTERED`.
- **Gotra** is never on `Member`; it is read from the Family. There is no endpoint that changes a Family's Gotra or `publicId`.
- **Nominee**: must be an ACTIVE Member of the **same Family**, not the Member themself (succession happens inside a Family, so a Nominee elsewhere could never succeed). `nomineePromptPending` becomes true for every Member of a Family without a Nominee when the Family reaches two ACTIVE Members (`onFamilyGainedMember`), and again for anyone whose Nominee is erased or archived. The named Nominee is never told (ADR-0018).
- **Head succession** (`succeedHead(tx, familyId)`), run in the same transaction as the Head's Erasure or Archival: candidates are the Family's other ACTIVE Members. The departing Head's Nominee, if a candidate, succeeds; else the oldest candidate by `dateOfBirth` (ties: earliest `FamilyLink.createdAt`). No candidates → Family `ARCHIVED`, `headMemberId = null`, `payments.releaseHeadAnchor(familyId)`. Write a Processing Record `HEAD_SUCCEEDED` or `FAMILY_ARCHIVED`. (Voluntary Head Transfer is Stage 3.)
- **Archival** (`archiveMember(tx, memberId, confirmedBy)`), called by Noticeboards when an Archival Request is confirmed: status `ARCHIVED`, `archivedAt`, `archivedBy`; sessions revoked (`DECEASED`); succession if Head; others' Nominee pointers to them cleared (prompt set); run the `onMemberArchived` hooks (Blood SOS cancels their open request; Events revokes their passes). Data is kept, not erased. `unarchiveMember` (Officer revert of a false Archival) restores `ACTIVE`; it does not undo a succession — the Officer is told so in the response.
- **Directory** lists ACTIVE Members only (invariant 9).

## Erasure (invariant 17)

`eraseMember(tx, memberId, actor)` — the single implementation used by the Officer (Stage 1) and by the Member (Stage 2). One transaction:

1. Lock the Member row. If they are their Family's Head → `succeedHead`.
2. Clear every other Member's `nomineeMemberId` pointing at them (set their prompt).
3. Run registered `onMemberErased(tx, memberId)` hooks. Modules register these at boot with `register.onMemberErased(handler)` so Register never imports them:
   - Noticeboards: scrub author fields on their Shok Sandesh Notices (text retained as Historical Content, author shown as "a former member"); delete their Business Listings and Reports they filed; lift/delete their suspensions.
   - Blood SOS: cancel their open request; delete their alerts, responses and donor preferences.
   - Events: delete their passes and admissions.
   - Notifications: delete their device tokens.
   - Media: mark all their images `REMOVED` and enqueue S3 deletion after commit.
   - Identity: revoke all sessions (`ERASURE`), delete their role rows.
4. `payments.moveToRestricted(tx, memberId, retainUntil)`; move their ConsentEvents to `restricted.consent_event`; insert `restricted.member_tombstone`.
5. Delete the Family Link and the Member row.
6. Mark their `ErasureRequest` `EXECUTED`.
7. Processing Record `MEMBER_ERASED` with the actor (`SELF` or the Officer) — subject is the member ID only.

After commit, a job deletes the S3 objects. The phone number is free again: the person may register afresh later, and their old Payment Identity no longer anchors a Family (unless succession kept the Family alive — then the anchor stays with the Family, per `payments.md`).

**Stage 1 (Officer-executed):** `POST /v1/me/erasure` creates a `PENDING` ErasureRequest and returns `202`; the Officer executes it from the Officer route. Stage 2 (`ERASURE_SELF_SERVICE=true`): the same endpoint executes immediately when the body carries a Firebase ID token with `auth_time` in the last 5 minutes (re-authentication), returns `200`, and clears the cookie.

Withdrawing the directory-listing consent **is** an Erasure request (`CONTEXT.md`, Consent Toggle); there is no consent endpoint that sets `consentDirectory` false.

## Endpoints

| Method | Path | Auth | Stage | Notes |
|---|---|---|---|---|
| GET | `/v1/me` | member | 1 | SELF projection + `family: { publicId, gotra, isHead, memberCount }` + `roles` + `prompts: { nominee: boolean }` + `officerMessages` (unread first) + `suspension` (Stage 2) + `erasureRequest` status |
| PATCH | `/v1/me` | member | 1 | Editable: `name`, `nameEnConfirmed`, `fatherOrHusbandName`, `gender`, `dateOfBirth` (still adult), `bloodGroup`, `address` (district recomputed), `nativePlace`, `kuldevi`, `kuldevta`, `uiLanguage`. Not editable: phone, Gotra, Family. |
| PUT | `/v1/me/consents` | member | 1 | Partial `{ directory?: true, bloodGroupMatching?: boolean, photoVisible?: boolean }`; at least one field required → ConsentEvents for changes. Directory consent can only be reaffirmed here; withdraw it through Erasure. |
| PUT | `/v1/me/nominee` | member | 1 | `{ nomineeMemberId: string \| null }`; validation above; clears the prompt |
| POST | `/v1/me/nominee-prompt/dismiss` | member | 1 | Clears the prompt without naming anyone |
| PUT | `/v1/me/photo` | member | 1 | `{ imageId: string \| null }` — an image the Member uploaded |
| POST | `/v1/me/officer-messages/:id/read` | member | 1 | |
| POST | `/v1/me/erasure` | member | 1 / 2 | See Erasure |
| GET | `/v1/families/mine` | member | 1 | Family + every Member through FAMILY projection + `photoUrl` |
| PUT | `/v1/families/mine/photo` | Head | 1 | `{ imageId: string \| null }` |
| GET | `/v1/directory/members` | member | 2 | Query: `q`, `gotra`, `city`, `state`, `familyPublicId`, cursor. Projections. |
| GET | `/v1/directory/families/:publicId` | member | 2 | Family + Members projected per viewer |
| GET | `/v1/directory/members/:memberId` | member | 2 | One projection |
| POST | `/v1/families/mine/invites` | member | 2 | → `{ code, url, expiresAt }`; `url` = `${WEB_BASE_URL}/join/${code}` |
| GET | `/v1/invites/:code` | public | 2 | → `{ familyPublicId, gotra }` or 404; rate-limited like `family-check` |

### Directory search

- `q` shorter than 2 characters is ignored.
- `q` containing Devanagari: match `name_hi` by trigram similarity, **and** romanize `q` (cached) and match `name_en` / `name_en_search_key`.
- `q` in Latin: match `name_en` and `name_en_search_key` by trigram similarity (`%` operator, threshold 0.3) or `ILIKE q || '%'`.
- `q` matching `^AGR-` → exact `familyPublicId`.
- Filters are exact: `gotra` enum, `state` enum, `city` via `cityKey`.
- Order: similarity desc, then `nameEn`/`nameHi`. Never search or filter on any field outside the SAMAJ column set — searching by phone or pincode would leak Member-only fields through the result set.
- Directory search and lookups expose only directory-consenting Members to the wider Samaj. Self and Family viewers retain their own/Family projections; the directory consent does not filter Register projections consumed by other modules.
- Family directory lookup counts and identifies only visible active Members; an opted-out head's `headMemberId` is omitted for non-Family viewers.

## Jobs

| Job | Trigger | Effect |
|---|---|---|
| `register.fillDistrict` | on lookup failure; retry with backoff for 24 h | Fill `district` from PincodeDirectory |
| `register.purgeRestricted` | daily 03:00 IST | Delete `restricted.*` rows with `retainUntil <` the database's `now()`, via `restricted.purge_expired()` |

## Public interface (`index.ts`)

```ts
createFamilyWithHead(tx, input): Promise<{ familyId: string; memberId: string }>
createMemberInFamily(tx, familyId: string, input): Promise<{ memberId: string }>
onFamilyGainedMember(tx, familyId: string): Promise<void>
isHeadOf(memberId: string): Promise<boolean>
familyOf(memberId: string): Promise<{ familyId: string; publicId: string; gotra: Gotra; headMemberId: string | null }>
familyByPublicId(publicId: string): Promise<{ id: string; gotra: Gotra; status: FamilyStatus } | null>
project(viewerMemberId: string, memberIds: string[]): Promise<Map<string, MemberProjection>>
donorCandidates(filter): Promise<DonorRow[]>          // for Blood SOS only; see blood-sos.md
adultMembersOfFamily(familyId: string, exceptMemberId?: string): Promise<string[]>
archiveMember(tx, memberId: string, confirmedBy: Actor): Promise<void>
unarchiveMember(tx, memberId: string, officerId: string): Promise<{ successionReverted: false }>
eraseMember(tx, memberId: string, actor: Actor): Promise<void>
onMemberErased(handler): void
onMemberArchived(handler): void
handleImageRemoved(tx, { imageId, purpose }): Promise<void> // detach the matching Member or Family photo
postOfficerMessage(tx, memberId: string, kind: string, reason: string): Promise<void>
readNomineeForOfficer(tx, memberId: string, officerId: string, reason: NomineeReadReason): Promise<MemberProjection | null>
findPossibleDuplicates(profile): Promise<{ samePerson: string[]; sharedAddressHeads: string[] }>
```

`donorCandidates` is the one sanctioned exception to "only projections leave Register": it returns `memberId`, blood group, `cityKey`, `district`, `state` for Members with `consentBloodGroup = true`, for the Blood SOS matcher's use only; Blood SOS never returns those fields to any client (invariant 20).

## Required tests

- invariant 3: no API path leaves a Member with zero or two Family Links; a DB unique constraint rejects a second link.
- invariant 4: no route updates Gotra; a joiner's projected Gotra is the Family's.
- invariant 5: Head erasure with a Nominee in the Family → Nominee is Head; without → oldest Member; sole Member → Family `ARCHIVED` and HeadAnchor released.
- invariant 9: an archived Member is absent from every directory query.
- invariant 16: SAMAJ projection has no `phoneE164`; FAMILY has it.
- invariant 17: after Erasure — Member, link and images gone; sessions dead; `restricted.payment` holds their payment with `retainUntil`; the purge job removes it once the database's `now()` passes `retainUntil`, not before (the purge uses database time, not the fake clock; see architecture §Time).
- invariant 20: `bloodGroup` absent from SAMAJ and FAMILY projections and from every directory response.
- invariant 21: a Member with only `nameHi` projects `name.en = null`; `nameEnSearchKey` appears in no response body (assert by serialising every endpoint's response in the suite).
- invariant 22: a table-driven test over every `Member` column × relation asserts presence exactly as the table above; adding a column without updating the table fails the test.
- invariant 24: Officer Nominee read without a confirmed death or Archival Request → 403; with one → returned and a Processing Record written.
- invariant 25: `PHONE_ALREADY_REGISTERED` on a duplicate phone.
- Nominee in another Family → `422 NOMINEE_NOT_IN_FAMILY`; self → `422 NOMINEE_IS_SELF`.
- Media image removal clears only the matching Member or Family photo reference; unrelated photos remain attached.
- Directory search by `q` in Devanagari finds a Member who typed only English (via romanized query) and vice versa (via search key).
- Stage 1 erasure request → `202` + PENDING; with self-service enabled and a fresh token → executed; with a stale token → `401 REAUTH_REQUIRED`.

Module error codes: `PHONE_ALREADY_REGISTERED` 409, `NOMINEE_NOT_IN_FAMILY` 422, `NOMINEE_IS_SELF` 422, `NOT_ADULT` 422, `REAUTH_REQUIRED` 401, `MEMBER_NOT_FOUND` 404, `FAMILY_NOT_FOUND` 404, `NOT_HEAD` 403.
