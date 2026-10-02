# Module: Events

Owns Events, Organisers, Event Passes, gate manifests and scan synchronisation. Stage 2.

Read `CONTEXT.md` → Event Pass, Organiser, invariants 7, 19 and 23 first. ADR-0013 §10, ADR-0016 §17, ADR-0017 §12.

**Implementation status (2 October 2026):** re-claiming a `MEMBER_CANCELLED` pass below is an approved ADR-0026 requirement, not current behavior. The service still rejects an existing pass row with `PASS_ALREADY_EXISTS`; row reactivation and fresh signing remain open source work in `docs/REMAINING BACKEND WORK.md`.

## The rules this module exists to keep

- An Event Pass admits one Member to one Event, is non-transferable, is invalid once the Event ends, and verifies at the gate without network (invariant 19).
- An Event Pass never carries a charge (invariant 23).
- Accompanying minors are a headcount on the Head of Family's pass, never individually scanned (invariant 7).
- Only the app issues a pass; a gate device can verify one but never create one.
- A pass admitted twice at different offline gates is recorded for the Organiser after the fact, never blocked (CONTEXT.md, Event Pass).

## Models

```prisma
model Event {
  id              String      @id          // uuid v7
  title           String
  titleHi         String?
  description     String?
  descriptionHi   String?
  venue           String
  venueCity       String
  startsAt        DateTime
  endsAt          DateTime
  createdBy       String                   // memberId (Operator or Organiser)
  status          EventStatus @default(UPCOMING)
  createdAt       DateTime    @default(now())
  passes          EventPass[]
  @@index([status, startsAt])
}

enum EventStatus { UPCOMING ONGOING ENDED CANCELLED }

model EventPass {
  id              String          @id      // uuid v7; the pass identifier
  eventId         String
  event           Event           @relation(fields: [eventId], references: [id])
  memberId        String
  familyId        String
  isHead          Boolean                  // determines whether minorsCount is meaningful
  minorsCount     Int             @default(0)  // only on Head's pass
  status          PassStatus      @default(ACTIVE)
  qrPayload       String                  // the signed payload for offline verification
  issuedAt        DateTime        @default(now())
  revokedAt       DateTime?
  revokedReason   String?                  // EVENT_ENDED | EVENT_CANCELLED | MEMBER_CANCELLED | MEMBER_ERASED | MEMBER_ARCHIVED | OFFICER
  admissions      Admission[]
  @@unique([eventId, memberId])            // one pass per Member per Event (invariant 19)
  @@index([memberId])
  @@index([eventId, status])
}

enum PassStatus { ACTIVE REVOKED }

model Admission {
  id              String   @id
  passId          String
  pass            EventPass @relation(fields: [passId], references: [id])
  gateDeviceId    String                   // identifier of the scanning device
  scannedAt       DateTime
  scannedOffline  Boolean  @default(false) // true if synced after the fact
  @@unique([passId, gateDeviceId, scannedAt]) // idempotent sync
  @@index([passId])
  @@index([gateDeviceId, scannedAt])
}

model GateDevice {
  id              String   @id             // uuid v7
  eventId         String
  label           String                   // "Gate A", "Main Entrance"
  registeredBy    String                   // memberId of the Organiser whose app acts as this gate
  registeredAt    DateTime @default(now())
  @@index([eventId])
}
```

## Event Pass signing (Ed25519)

The server holds Ed25519 private keys configured in `EVENT_PASS_SIGNING_KEYS` (JSON array `[{ kid, privateKeyPem }]`). The first entry signs; all entries verify. Key rotation: add a new entry at position 0; existing passes remain verifiable by older keys until their Event ends.

### QR payload

The `qrPayload` stored on `EventPass` and encoded in the QR code:

```
<kid>.<base64url(payload)>.<base64url(signature)>
```

The signature covers the exact `payload` bytes, so the gate never re-serialises the JSON. `payload` is compact JSON:

```json
{
  "p": "<passId>",
  "e": "<eventId>",
  "m": "<memberId>",
  "h": true,
  "c": 2,
  "n": "Ramesh Agrawal",
  "x": 1728648000
}
```

| Field | Meaning |
|---|---|
| `p` | Pass ID |
| `e` | Event ID |
| `m` | Member ID |
| `h` | `isHead` — true if this pass carries minors |
| `c` | `minorsCount` — number of accompanying minors (0 if not head or no minors) |
| `n` | The Member's display name, in the script they supplied (invariant 21). The gate shows it so the Organiser can ask the holder's name, which is what makes the pass non-transferable (invariant 19). Name is Samaj-visible (invariant 22), so putting it in the QR shows nothing new. |
| `x` | Event `endsAt` as Unix epoch seconds — the gate device uses this for expiry |

`signature = Ed25519.sign(privateKey, payload_bytes)`.

### Gate verification (offline)

A gate device holds the public key(s). Verification:

1. Split `qrPayload` by `.` → `kid`, `payloadB64`, `signatureB64`.
2. Look up the public key by `kid`.
3. `Ed25519.verify(publicKey, decode(payloadB64), decode(signatureB64))` → valid/invalid.
4. Check `x >= now` → not expired.
5. Check `p` is not in the manifest's `revokedPassIds`, as of the manifest's last refresh.
6. Show `n` and `c` to the Organiser, record the admission locally, and sync later.

A pass revoked after the gate last refreshed its manifest still verifies at that gate. The gate app refreshes the manifest whenever it has network. This is the accepted cost of offline verification.

The gate **never** blocks a duplicate scan — if the same pass is scanned at two offline gates, both admissions are recorded. On sync, duplicates are surfaced to the Organiser (see Scan sync below).

## Event lifecycle

```
  UPCOMING ─── startsAt passes ──► ONGOING ─── endsAt passes ──► ENDED
      │                                │
      └── cancel ──────────────────────┘──► CANCELLED
```

- `UPCOMING → ONGOING`: a scheduled job (`events.startEvent`, `startAfter: startsAt`) sets the status. Passes can be issued while `UPCOMING` or `ONGOING`.
- `ONGOING → ENDED`: a scheduled job (`events.endEvent`, `startAfter: endsAt`) sets the status and bulk-revokes all ACTIVE passes (`revokedReason: EVENT_ENDED`).
- `CANCELLED`: an Organiser or Operator cancels; all ACTIVE passes revoked (`EVENT_CANCELLED`). No refunds exist because passes are free (invariant 23).

## Pass issuance

`POST /v1/events/:eventId/passes` — auth: member. A Member claims a pass for themselves.

1. Event must be `UPCOMING` or `ONGOING`. Else `409 EVENT_NOT_ACTIVE`.
2. Unique `(eventId, memberId)` — a second claim on an ACTIVE pass → `409 PASS_ALREADY_EXISTS`. A pass the Member themselves cancelled (`revokedReason: MEMBER_CANCELLED`) may be re-claimed (ADR-0026 §10): the existing row is reactivated — `status` ACTIVE, `revokedAt`/`revokedReason` cleared — and `qrPayload` is re-signed; no second row is created. A pass revoked by the Officer, by erasure or by archival cannot be re-claimed → `409 PASS_ALREADY_EXISTS`.
3. If the Member is Head of their Family, prompt for `minorsCount` (default 0). Non-Head Members get `minorsCount = 0`.
4. Sign the payload with the first key in `EVENT_PASS_SIGNING_KEYS`.
5. Insert `EventPass` with the `qrPayload`.
6. Response: `{ passId, qrPayload, event: { title, venue, startsAt, endsAt }, minorsCount }`.

The client renders `qrPayload` as a QR code. The pass is free (invariant 23): no payment flow, no order.

## Scan sync

Gate devices operate offline and sync admissions when connectivity returns.

`POST /v1/events/:eventId/admissions/sync` — auth: Organiser.

Body: `{ gateDeviceId, scans: [{ passId, scannedAt }] }`.

For each scan:
1. Verify `gateDeviceId` belongs to this event, and that the pass exists and belongs to this event.
2. Insert `Admission`. On unique violation (`passId + gateDeviceId + scannedAt`) → skip (idempotent).
3. If the same `passId` has admissions from **different** `gateDeviceId`s → flag as a duplicate admission.

Response: `{ synced: number, duplicates: [{ passId, admissions: [{ gateDeviceId, scannedAt }] }] }`.

The Organiser views duplicates on the event detail. A duplicate is informational, never punitive — connectivity is the problem, not the attendee.

## Gate manifest

Before the event, the Organiser downloads a manifest for offline use:

`GET /v1/events/:eventId/gate-manifest` — auth: Organiser.

Response: `{ eventId, endsAtEpoch, publicKeys: [{ kid, publicKeyPem }], passCount, revokedPassIds: string[], generatedAt }`.

The manifest does **not** contain pass holders' names or member IDs, which would leak the attendee list. It carries only the opaque IDs of revoked passes, so a cancelled or Officer-revoked pass is refused at a gate that has refreshed. The gate verifies everything else cryptographically from the QR.

`POST /v1/events/:eventId/gate-devices` `{ label }` (Organiser) registers the Organiser's app as a gate and returns `{ gateDeviceId }` plus the manifest. A gate is an Organiser's app in gate mode. It holds public keys only, so it can verify passes but never issue one.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/events` | Organiser or Operator | `{ title, titleHi?, description?, descriptionHi?, venue, venueCity, startsAt, endsAt }` |
| GET | `/v1/events` | member | Upcoming and ongoing events; cursor-paginated |
| GET | `/v1/events/:id` | member | Event detail; includes pass count for Organisers |
| PATCH | `/v1/events/:id` | Organiser (creator) or Operator | Update title, description, venue, times (if UPCOMING). Changing `endsAt` re-signs every ACTIVE pass (new `x`) and reschedules `events.endEvent`. Clients refetch their pass on the `EVENT_UPDATED` push or when they next open it. |
| POST | `/v1/events/:id/cancel` | Organiser (creator) or Operator | → CANCELLED; all passes revoked |
| POST | `/v1/events/:eventId/passes` | member | Claim a pass; `{ minorsCount? }` |
| GET | `/v1/events/:eventId/passes/mine` | member | The Member's own pass for this event (if any) |
| DELETE | `/v1/events/:eventId/passes/mine` | member | Cancel own pass before the event ends → `REVOKED`, `revokedReason: MEMBER_CANCELLED`; re-claim later by calling `POST /v1/events/:eventId/passes` again — the row is reactivated and re-signed (ADR-0026 §10) |
| GET | `/v1/events/:eventId/passes` | Organiser | All passes for an event; with SAMAJ projection of each Member |
| POST | `/v1/events/:eventId/gate-devices` | Organiser | Register this app as a gate |
| GET | `/v1/events/:eventId/gate-manifest` | Organiser | Public keys, revoked pass IDs, metadata |
| POST | `/v1/events/:eventId/admissions/sync` | Organiser | Sync offline gate scans |
| GET | `/v1/events/:eventId/admissions` | Organiser | Admission log with duplicate flags |
| GET | `/v1/me/passes` | member | All active passes for the signed-in Member |

### Submission schemas

```ts
const CreateEventBody = z.object({
  title: z.string().trim().min(1).max(200),
  titleHi: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  descriptionHi: z.string().trim().max(2000).optional(),
  venue: z.string().trim().min(1).max(200),
  venueCity: z.string().trim().min(1).max(80),
  startsAt: z.string().datetime(),                    // ISO-8601 UTC
  endsAt: z.string().datetime(),
}).refine(v => new Date(v.endsAt) > new Date(v.startsAt), "endsAt must be after startsAt");

const ClaimPassBody = z.object({
  minorsCount: z.number().int().min(0).max(20).default(0),
});

const SyncAdmissionsBody = z.object({
  gateDeviceId: z.string().uuid(),
  scans: z.array(z.object({
    passId: z.string().uuid(),
    scannedAt: z.string().datetime(),
  })).min(1).max(500),
});
```

## Erasure hooks (registered with `register.onMemberErased`)

- Their passes: `REVOKED`, `revokedReason: MEMBER_ERASED`.
- Their admissions: retained (anonymous event analytics); `passId` still links but the Member row is gone.

## Archival hooks (registered with `register.onMemberArchived`)

- Their active passes: `REVOKED`, `revokedReason: MEMBER_ARCHIVED`.

## Officer actions

- `POST /v1/officer/passes/:passId/revoke` `{ reason }` → `REVOKED`, `revokedReason: OFFICER`. Processing Record `PASS_REVOKED`. For abusive attendees or incorrect passes.

## Jobs

| Job | Trigger | Effect |
|---|---|---|
| `events.startEvent` | `startAfter: startsAt` | UPCOMING → ONGOING |
| `events.endEvent` | `startAfter: endsAt` | ONGOING → ENDED; bulk-revoke ACTIVE passes |

No cron jobs; timed per-entity jobs.

## Rate limits

| Name | Key | Limit |
|---|---|---|
| `event.create` | memberId | 10 / hour |
| `pass.claim` | memberId | 30 / hour |
| `admissions.sync` | memberId | 60 / hour |

## Public interface (`index.ts`)

```ts
revokePassesForMember(tx, memberId: string, reason: string): Promise<void>    // Erasure/Archival hook
```

## Required tests

- invariant 19: one pass per Member per Event — second claim → `409 PASS_ALREADY_EXISTS`; the pass's `qrPayload` verifies with only `node:crypto` Ed25519 and the public key, no network call.
- invariant 19: a pass for an ENDED event → verification check `x < now` fails; `POST /v1/events/:id/passes` on an ENDED event → `409 EVENT_NOT_ACTIVE`.
- invariant 23: no payment purpose `EVENT_PASS` exists; no payment flow in the pass claim.
- invariant 7: a non-Head Member's pass has `minorsCount = 0` even if they supply a value; a Head's pass carries the supplied count.
- Offline duplicate: two admissions for the same pass from different `gateDeviceId`s → `duplicates` array in the sync response.
- Event cancellation: all passes revoked; a claim after cancellation → `409 EVENT_NOT_ACTIVE`.
- Re-claim: a `MEMBER_CANCELLED` pass re-claimed reactivates the same row with a fresh signature (no second row); an Officer-revoked pass cannot be re-claimed → `409 PASS_ALREADY_EXISTS` (ADR-0026 §10).
- Erasure: Member erased → their passes revoked with `MEMBER_ERASED`.
- Key rotation: a pass signed with key `kid=1` verifies when `EVENT_PASS_SIGNING_KEYS` has `[{ kid: 2, ... }, { kid: 1, ... }]`.
- Gate manifest contains public keys, event metadata and revoked pass IDs, but no member IDs and no names.
- A pass revoked by the Officer appears in the next manifest's `revokedPassIds`.
- Changing an Event's `endsAt` re-signs its ACTIVE passes, and the new `qrPayload` carries the new `x`.
- Sync with a `gateDeviceId` from a different event → `403`.
- Forgery: a payload whose signature was made with a key not in `EVENT_PASS_SIGNING_KEYS` fails verification. So does a payload with `c` edited after signing.
- `startEvent` job at `startsAt` (fake clock) → UPCOMING becomes ONGOING.
- `endEvent` job at `endsAt` (fake clock) → ONGOING becomes ENDED, all passes revoked.

Module error codes: `GATE_DEVICE_NOT_FOR_EVENT` 403, `EVENT_NOT_FOUND` 404, `EVENT_NOT_ACTIVE` 409, `PASS_ALREADY_EXISTS` 409, `PASS_NOT_FOUND` 404, `NOT_ORGANISER` 403.

## What the Flutter app must change

- **Pass signing moves to the server.** `events/domain/repositories/events_repository.dart` currently builds the pass on the device and signs it with SHA-256 over a salt compiled into the app (`secret_salt_samaj`). Anyone with the APK can read that salt and forge passes. The HTTP repository must call `POST /v1/events/:eventId/passes` and render the returned `qrPayload` unchanged. The local signing code is deleted, not kept as a fallback. The in-memory test repository may keep a fake signer, but not that salt.
- **Gate mode verifies Ed25519** against the manifest's public keys and checks `x` and `revokedPassIds` (see Gate verification). It never accepts a SHA-256 pass.
- The pass ID is the server's UUID, not `pass_<eventId>_<memberId>`.
