# Module: Blood SOS

Owns urgent blood donor requests: raising, widening, matching, Donor Reach and fulfilment. Stage 2.

Read `CONTEXT.md` → Blood SOS, Donor, Donor Reach, invariants 15 and 20 first. ADR-0011 (density floor), ADR-0025 (place-based widening). ADR-0025 replaces the km radius ladder of ADR-0004 §5 and ADR-0006 §4 with widening by place: city → district → state. There is no GPS and no distance.

## The rule this module exists to keep

A Blood SOS always reports its Donor Reach to the requester, and widens beyond blood-group matching rather than notifying almost nobody (invariant 15). Blood Group is never displayed to anyone (invariant 20): it is used only for matching inside this module; no endpoint returns it.

## Geographic model

The register holds no coordinates. Nearness is determined by **place**, looked up from the hospital's pincode:

| Tier | Scope | Matches |
|---|---|---|
| 1 (immediate) | Hospital's **city** (`cityKey`) | Exact blood group |
| 2 (+30 min) | Hospital's **district** | Compatible blood group |
| 3 (+60 min) | Hospital's **state** | Compatible blood group |

"Compatible" means the clinical red-cell compatibility matrix: a Donor whose group can give to the needed group. ADR-0006 §4 made Tier 1 exact-only and the wider tiers compatible, and ADR-0011 says the matrix still decides who counts as "matching". The matrix is a constant in `blood-sos/compatibility.ts` with its own table test.

Each tier is reached by a timed job (`startAfter`). The request expires at `createdAt + SOS_EXPIRY_HOURS`. Urgency, where the requester supplied it, is shown to donors but changes nothing: no tier fires earlier and no tier is skipped (ADR-0026 §7).

### Density floor (ADR-0011)

Tier 1 only. After exact matching in the city, the floor test counts **compatible** Donors in the city. If that count is below `SOS_DENSITY_FLOOR`, the request immediately notifies **all Donors in the city**, whatever their blood group. It doesn't wait for Tier 2. Tiers 2 and 3 still run on schedule, with compatible matching. They never fall back to every Donor in a district or state: ADR-0011 and CONTEXT.md (Donor Reach) scope the fallback to the city. The requester always sees the full Donor Reach, so nobody believes many were notified when almost nobody was.

## Models

```prisma
model BloodSosRequest {
  id                 String           @id          // uuid v7
  requesterMemberId  String
  status             SosStatus        @default(ACTIVE)
  bloodGroup         BloodGroup                    // the needed group
  hospitalName       String
  hospitalPincode    String
  hospitalCity       String                        // from PincodeDirectory
  hospitalCityKey    String
  hospitalDistrict   String?                       // null when the place came from the requester and they have none
  hospitalState      String
  placeSource        SosPlaceSource                // PINCODE, or REQUESTER when the pincode lookup failed
  patientName        String?
  unitsNeeded        Int?
  note               String?
  urgency            SosUrgency?                   // display-only; widening stays place-driven (ADR-0026 §7)
  patientRelation    String?                       // free text, e.g. "father"; shown to responding donors
  hospitalArea       String?                       // free-text ward/block; shown to responding donors
  currentTier        Int              @default(1)  // 1 = city, 2 = district, 3 = state
  donorReachTotal    Int              @default(0)  // running sum of accepted sends
  createdAt          DateTime         @default(now())
  expiresAt          DateTime                      // createdAt + SOS_EXPIRY_HOURS
  fulfilledAt        DateTime?
  closedAt           DateTime?
  closedBy           String?                       // requester memberId, or "OFFICER:<id>"
  closedReason       String?                       // FULFILLED | CANCELLED | EXPIRED | OFFICER | MEMBER_ERASED | MEMBER_ARCHIVED
  alerts             BloodSosAlert[]
  @@index([requesterMemberId])
  @@index([status, expiresAt])
  // one ACTIVE per Member: the partial unique index below, in raw SQL. Never @@unique([requesterMemberId, status]),
  // which would also stop a Member holding two CLOSED requests.
}

enum SosStatus { ACTIVE CLOSED }
enum SosPlaceSource { PINCODE REQUESTER }
enum SosUrgency { WITHIN_2_HOURS TODAY TOMORROW }

model BloodSosAlert {
  id              String   @id
  requestId       String
  request         BloodSosRequest @relation(fields: [requestId], references: [id])
  tier            Int                              // 1, 2 or 3
  donorMemberId   String
  bloodGroupMatch Boolean                          // true if exact match, false if density-floor fallback
  accepted        Boolean                          // FCM accepted at least one token
  createdAt       DateTime @default(now())
  @@unique([requestId, donorMemberId])             // one alert per donor per request
  @@index([donorMemberId])
}

model BloodSosResponse {
  id              String   @id
  requestId       String
  donorMemberId   String
  createdAt       DateTime @default(now())
  @@unique([requestId, donorMemberId])
}

model DonorPreference {
  memberId      String    @id
  snoozedAt     DateTime?
  snoozeUntil   DateTime?                          // null = snoozed indefinitely until unsnooze
  lastDonatedOn DateTime? @db.Date                 // self-reported; drives the donation cooldown
  @@index([snoozeUntil])
}

model DonorAlertDay {                              // per-Donor daily alert cap (ADR-0006 §4)
  memberId String
  dayIst   DateTime @db.Date                       // clock.todayIst()
  count    Int      @default(0)
  @@id([memberId, dayIst])
}
```

Partial unique index (raw SQL):

```sql
CREATE UNIQUE INDEX blood_sos_one_active_per_member
  ON blood_sos_request (requester_member_id) WHERE status = 'ACTIVE';
```

## Configuration defaults

| Variable | Default | Notes |
|---|---|---|
| `SOS_TIER_INTERVAL_MINUTES` | `30` | Delay between widening tiers |
| `SOS_EXPIRY_HOURS` | `24` | Request auto-closes after this |
| `SOS_DENSITY_FLOOR` | `5` | Min compatible Donors in the city before the Tier 1 all-group fallback (ADR-0011) |
| `DONOR_COOLDOWN_DAYS` | `90` | A Donor who reports a donation within this many days isn't alerted |
| `DONOR_DAILY_ALERT_CAP` | `3` | Most Blood SOS alerts one Donor receives per IST day (ADR-0006 §4) |

## Donor matching

A **Donor** is a Member with `consentBloodGroup = true` who isn't snoozed and isn't in the donation cooldown (CONTEXT.md, Donor). The cooldown is the one medical eligibility rule: a Member who reports a donation on `lastDonatedOn` is not a Donor until `DONOR_COOLDOWN_DAYS` have passed. The date is self-reported and optional; no date means no cooldown. The app has no separate city-wide consent. Consenting to the blood-group toggle is consent to every tier, the fallback included.

The matching query at each tier:

1. Call `register.donorCandidates({ bloodGroup, cityKey?, district?, state?, excludeMemberIds })` — Register returns `memberId`, `bloodGroup`, `cityKey`, `district`, `state` for Members with `consentBloodGroup = true` (the one sanctioned exception from `register.md`). The requester is excluded.
2. Filter out snoozed Donors: exclude any Donor with a `DonorPreference` row where `snoozedAt IS NOT NULL` and (`snoozeUntil IS NULL` — indefinite — or `snoozeUntil > now` — still active). A Donor with no `DonorPreference` row or with `snoozedAt IS NULL` is not snoozed.
3. Filter out Donors in cooldown: `lastDonatedOn > todayIst - DONOR_COOLDOWN_DAYS`.
4. Filter out already-alerted Donors (from `BloodSosAlert` for this request), and Donors whose `DonorAlertDay.count` for today has reached `DONOR_DAILY_ALERT_CAP`.
5. Tier geography filter:
   - Tier 1: `cityKey = hospitalCityKey`
   - Tier 2: `district = hospitalDistrict` (skipped if `hospitalDistrict` is null)
   - Tier 3: `state = hospitalState`
6. Blood group: Tier 1 exact, Tiers 2–3 compatible. At Tier 1 only, if compatible Donors in the city (not yet alerted) number fewer than `SOS_DENSITY_FLOOR`, a second pass takes all Donors in the city, whatever their blood group.

Filters 2–4 apply to both passes: a snoozed, cooling-down or capped Donor is never reached, not even by the fallback.

### Sending alerts

`notifications.send(donorMemberIds, { topic: BLOOD_SOS_ALERT, subjectId: requestId, title, body, data: { requestId } })`.

The push data carries only the opaque request ID. The client fetches the request through the authenticated Blood SOS detail endpoint, which applies the normal authorization rules before returning hospital and request details. No blood group, hospital field, donor member ID, phone or address field is placed in push data.

Per donor: insert `BloodSosAlert` with `accepted` from the notification result, and increment `DonorAlertDay.count` when the alert was accepted. Update `donorReachTotal += count of accepted`. A rejected or failed push records `accepted: false`, does not count toward Donor Reach, and cannot prevent the request's widening or expiry lifecycle.

### Donor Reach (invariant 15)

`donorReachTotal` on the request is the running count of Donors for whom FCM accepted the alert for at least one device. A Donor with no reachable device is not counted (CONTEXT.md, Donor Reach). This number is returned to the requester on every read of their request.

## Widening jobs

At request creation:
- Persist the `ACTIVE` request, then enqueue `bloodSos.widenTier2` with `startAfter: now + SOS_TIER_INTERVAL_MINUTES`, `bloodSos.widenTier3` with `startAfter: now + 2 * SOS_TIER_INTERVAL_MINUTES`, and `bloodSos.expire` with `startAfter: expiresAt`.
- Immediately run Tier 1. A failed or rejected push is isolated to that Donor; it cannot strand an `ACTIVE` request or suppress the widening and expiry jobs.

Each widening job:
1. Re-read the request. If not `ACTIVE` → exit (already fulfilled/closed).
2. If `hospitalDistrict` is null (Tier 2), send nothing, set `currentTier = 2`, and leave the state to Tier 3.
3. Run the matching query for the tier.
4. Send alerts.
5. Update `currentTier`.

## Donor response

`POST /v1/blood-sos/:id/respond` — a Donor signals willingness. Only a Member who holds a `BloodSosAlert` for this request may respond (`403 SOS_NOT_ALERTED`). Inserts `BloodSosResponse`; pushes the requester `{ topic: BLOOD_SOS_RESPONSE, subjectId: requestId, data: { requestId } }`. The requester then sees the donor's SAMAJ projection (name, city, state — no phone, no blood group) on the request detail.

The response does **not** share the donor's phone number. Contact between requester and donor is out of scope until chat ships (Stage 3).

## Snooze / unsnooze

`PUT /v1/me/blood-sos/snooze` `{ until?: string }` — ISO date or null (indefinite). A snoozed Donor is excluded from **every** widening tier, including the city fallback (CONTEXT.md, Donor). Snoozed is a preference, not a consent withdrawal; `consentBloodGroup` stays true.

`DELETE /v1/me/blood-sos/snooze` — unsnooze.

`PUT /v1/me/blood-sos/last-donation` `{ donatedOn: "YYYY-MM-DD" | null }` sets or clears `lastDonatedOn`. The date can't be in the future. `GET /v1/me/blood-sos/donor-status` returns `{ isDonor, snoozeUntil, lastDonatedOn, eligibleFrom }` and never the blood group itself.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/blood-sos` | member | `{ bloodGroup, hospitalName, hospitalPincode, patientName?, unitsNeeded?, note?, urgency?, patientRelation?, hospitalArea? }` → creates and triggers Tier 1. City, district and state come from `PincodeDirectory` (through `PincodeCache`). If the lookup fails, they come from the requester's own register address with `placeSource = REQUESTER`, and the response says so. An emergency is never refused because a vendor is down. Rate-limited. Idempotency-Key. |
| GET | `/v1/blood-sos/mine` | member | The requester's active request (if any) + recent closed; `donorReach`, `responses` |
| GET | `/v1/blood-sos/:id` | member | Detail: SAMAJ projections of responding Donors; the requester sees `donorReachTotal`. Other Members see: `bloodGroup`, `hospitalName`, `hospitalCity`, `urgency`, `patientRelation`, `hospitalArea`, `patientName`, `status`. |
| POST | `/v1/blood-sos/:id/fulfil` | member (requester) | → `CLOSED`, `closedReason: FULFILLED`. Halts further widening. |
| POST | `/v1/blood-sos/:id/cancel` | member (requester) | → `CLOSED`, `closedReason: CANCELLED`. Halts widening. |
| POST | `/v1/blood-sos/:id/respond` | member (donor) | Signal willingness |
| POST | `/v1/blood-sos/:id/report` | member | → creates a `Report` with `targetType: BLOOD_SOS`; never auto-hides (CONTEXT.md, Report). Appears in Officer queue. |
| PUT | `/v1/me/blood-sos/snooze` | member | `{ until? }` |
| DELETE | `/v1/me/blood-sos/snooze` | member | |
| PUT | `/v1/me/blood-sos/last-donation` | member | `{ donatedOn }` |
| GET | `/v1/me/blood-sos/donor-status` | member | No blood group in the body |

### Submission schema

```ts
const BloodSosCreateBody = z.object({
  bloodGroup: z.enum(["A_POS","A_NEG","B_POS","B_NEG","AB_POS","AB_NEG","O_POS","O_NEG"]),
  hospitalName: z.string().trim().min(1).max(200),
  hospitalPincode: z.string().regex(/^[1-9]\d{5}$/),
  patientName: z.string().trim().max(120).optional(),
  unitsNeeded: z.number().int().min(1).max(20).optional(),
  note: z.string().trim().max(500).optional(),
  urgency: z.enum(["WITHIN_2_HOURS", "TODAY", "TOMORROW"]).optional(),   // display-only (ADR-0026 §7)
  patientRelation: z.string().trim().max(80).optional(),
  hospitalArea: z.string().trim().max(200).optional(),
});
```

## Officer actions

- `POST /v1/officer/blood-sos/:id/close` `{ reason }` → `CLOSED`, `closedBy: "OFFICER:<id>"`, `closedReason: OFFICER`. For abusive requests. Processing Record `BLOOD_SOS_REPORT_RESOLVED`.
- `GET /v1/officer/reports?target=BLOOD_SOS` → Reports targeting Blood SOS requests, with the request detail.

## Erasure hooks (registered with `register.onMemberErased`)

- Their open request: `CLOSED`, `closedReason: MEMBER_ERASED`.
- Their alerts: deleted.
- Their responses: deleted.
- Their `DonorPreference`: deleted.

## Archival hooks (registered with `register.onMemberArchived`)

- Their open request: `CLOSED`, `closedReason: MEMBER_ARCHIVED`.

## Jobs

| Job | Trigger | Effect |
|---|---|---|
| `bloodSos.widenTier2` | `startAfter: +30 min` | Run Tier 2 matching if still ACTIVE |
| `bloodSos.widenTier3` | `startAfter: +60 min` | Run Tier 3 matching if still ACTIVE |
| `bloodSos.expire` | `startAfter: expiresAt` | ACTIVE → CLOSED, `closedReason: EXPIRED` |

No cron jobs; timed per-entity jobs with `startAfter` as specified in `architecture.md`.

## Rate limits

| Name | Key | Limit |
|---|---|---|
| `bloodSos.create` | memberId | 3 / hour |
| `bloodSos.respond` | memberId | 30 / hour |
| `bloodSos.report` | memberId | 10 / hour |

## Public interface (`index.ts`)

```ts
cancelForMember(tx, memberId: string, reason: string): Promise<void>    // Erasure/Archival hook
```

## Required tests

- invariant 15: a request raised for a pincode with 2 matching Donors (below density floor) widens to all Donors in the city; `donorReachTotal` equals the number FCM accepted; the requester sees the count.
- invariant 15: a request with zero matching Donors at Tier 1 → fallback fires; `donorReachTotal` reflects the fallback sends.
- invariant 20: no endpoint response body contains `bloodGroup` for any Donor — assert by serialising every Blood SOS response in the suite.
- Tier widening: Tier 1 fires immediately; Tier 2 fires at `+30 min` (fake clock); Tier 3 at `+60 min`.
- A snoozed Donor is never alerted, not even at the city fallback.
- A Donor with `lastDonatedOn` 30 days ago is never alerted; at 91 days they are.
- Compatibility: an O_NEG Donor in the district is alerted at Tier 2 for an A_POS request; an A_POS Donor in the city is not alerted at Tier 1 for an O_NEG request unless the fallback fires.
- Fallback scope: a Tier 2 or Tier 3 with few matches does not alert non-compatible Donors in the district or state.
- Daily cap: a Donor already alerted `DONOR_DAILY_ALERT_CAP` times today is skipped and not counted in Donor Reach.
- One active request per Member: a second `POST /v1/blood-sos` while one is ACTIVE → `409 SOS_ALREADY_ACTIVE`.
- Fulfilment closes the request; subsequent widening jobs exit without sending.
- Expiry at 24 hours (fake clock) → CLOSED.
- Erasure: requester erased → request CLOSED; donor erased → their alerts and responses deleted; their `DonorPreference` deleted.
- Officer close: request CLOSED, Processing Record written.
- Report on a Blood SOS: stored but no auto-hiding, no suspension.
- Hospital pincode lookup fails: the request is created with the requester's city, district and state, and `placeSource = REQUESTER`. If the requester has no district, Tier 2 sends nothing and Tier 3 matches by state.
- An SOS created with `urgency`, `patientRelation` and `hospitalArea` stores them and returns them to the requester; the tier jobs run on the normal schedule regardless of urgency (ADR-0026 §7).

Module error codes: `SOS_ALREADY_ACTIVE` 409, `SOS_NOT_FOUND` 404, `SOS_ALREADY_CLOSED` 409, `SOS_NOT_REQUESTER` 403, `SOS_NOT_ALERTED` 403.

## What the Flutter app must change

`lib/features/blood_sos/domain/blood_sos_models.dart` (repository root) predates the place-based ladder:

- **`BloodSosRadiusTier`** (25/50/100 km) is replaced by the tier the API returns: `currentTier` 1–3, labelled City, District, State. Remove `radiusKm`.
- **`BloodSosStatus.widened` and `isCityWidened`** aren't API states. The API has `ACTIVE`/`CLOSED`, plus `closedReason` and `currentTier`. Show "widened" from `currentTier > 1`.
- **`DonorResponse.distanceKm` and `eta`** can't exist, because the register holds no coordinates. `area` becomes the Donor's city from the SAMAJ projection.
- **`DonorPreferences.cityWideConsent`** is dropped: blood-group consent covers every tier. `isAvailable` is the inverse of snooze. `lastDonatedAt` and `cooldownDaysRequired` map to `lastDonatedOn` and the server's `DONOR_COOLDOWN_DAYS`, and the app shouldn't hard-code 90.
- **`urgency`, `patientRelation`, `hospitalArea`** are accepted by the API (ADR-0026 §7): send them in the create body. Urgency is display-only — it must not change tier timing, matching or reach.
