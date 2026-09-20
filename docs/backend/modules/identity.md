# Module: Identity

Owns sign-in, sessions, principals and roles. Stage 1.

## What it does

A person proves control of a phone with Firebase Phone Auth on the client; the API verifies the resulting Firebase ID token once, then issues its own opaque session (ADR-0014 §3). From then on the API never talks to Firebase for that person again until they sign in afresh.

A session belongs to a **principal**, which is one of:
- **Applicant** — a verified phone with no Member. Carries the current `registrationId`.
- **Member** — a verified phone that belongs to an active Member. Carries `memberId` and roles.

A phone belongs to at most one Member (invariant 25). An archived (deceased) Member's phone cannot sign in and cannot be used for a new Registration.

## Models

```prisma
model Session {
  id           String    @id            // uuid v7
  tokenHash    String    @unique        // sha256(token), hex
  client       SessionClient            // WEB | MOBILE
  phoneE164    String                   // "+919812345678"
  memberId     String?                  // set once the principal is a Member
  registrationId String?                // set while the principal is an Applicant
  createdAt    DateTime  @default(now())
  lastSeenAt   DateTime  @default(now())
  expiresAt    DateTime
  revokedAt    DateTime?
  revokedReason String?                 // LOGOUT | ERASURE | ARCHIVAL | OFFICER | EXPIRED_IDLE
  userAgent    String?
  @@index([memberId])
  @@index([phoneE164])
}

enum SessionClient { WEB MOBILE }

model MemberRole {
  memberId  String
  role      Role
  grantedBy String?          // memberId of the granting Operator; null for seed
  grantedAt DateTime @default(now())
  @@id([memberId, role])
}

enum Role { OFFICER OPERATOR ORGANISER }

model RateLimitBucket {
  name        String
  key         String
  windowStart DateTime
  count       Int
  @@id([name, key, windowStart])
}
```

Head of Family is **not** a role row: it is derived from `Family.headMemberId` (Register) at request time, so a succession never leaves a stale role behind.

The first Officer and Operator (Mr Rahul, ADR-0016) are granted by a one-off seed script `npm run seed:roles -- --phone +91… --role OFFICER --role OPERATOR` that refuses to run if the phone has no Member; the script writes a Processing Record row with actor `SYSTEM`.

## Tokens and cookies

- Token: 32 bytes from `crypto.randomBytes`, base64url. Only `sha256(token)` is stored.
- Web: `Set-Cookie: sid=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<ttl>`; host-only (no `Domain` attribute) on the API host. The token is never in the response body for web.
- Mobile: token returned in the body; the app keeps it in `flutter_secure_storage` and sends `Authorization: Bearer <token>`.
- Sliding expiry: on each authenticated request, if `lastSeenAt` is older than 1 hour, update `lastSeenAt` and extend `expiresAt` to now + TTL (web 30 days, mobile 90 days). Idle beyond TTL → expired.
- A request presenting both a cookie and a bearer token is rejected `400 VALIDATION_FAILED`.

## Rules

1. **Token verification**: `verifyIdToken(idToken, /* checkRevoked */ true)`; require `firebase.sign_in_provider === "phone"`, `phone_number` matching `^\+91[6-9]\d{9}$`, and `auth_time` within the last 10 minutes. Otherwise `401 FIREBASE_TOKEN_INVALID`.
2. **Principal resolution** on session creation, by `phone_number`:
   - An ACTIVE Member holds the phone → Member principal.
   - An ARCHIVED Member holds the phone → `403 PHONE_BELONGS_TO_ARCHIVED_MEMBER`.
   - Otherwise → Applicant principal. Ask Registration for the phone's Registration: `registration.openForPhone(phone)` (see `registration.md` for which Registration is resumed and which is abandoned).
3. **Upgrade in place**: when a Registration completes, Registration calls `identity.promoteToMember(tx, registrationId, memberId)`, which sets `memberId` and clears `registrationId` on every live session of that phone. The client keeps its cookie/token.
4. **Revocation**: `identity.revokeAllForMember(tx, memberId, reason)` — called by Erasure, Archival and Officer actions. Takes effect on the very next request (sessions are looked up on every request; no caching).
5. **Roles** are read from `MemberRole` on every request (one indexed query) so a grant or revoke is immediate.

## Middleware (`src/http/auth.ts`)

- `authenticate` (global): resolves cookie or bearer → session → principal; attaches `req.principal = { kind: 'APPLICANT', sessionId, phoneE164, registrationId } | { kind: 'MEMBER', sessionId, phoneE164, memberId, roles: Role[], isHead: boolean }`. Missing credentials → `req.principal = null`.
- `requirePrincipal`, `requireApplicant`, `requireMember`, `requireRole(role)`, `requireHead` → `401 UNAUTHENTICATED` / `403 FORBIDDEN`.
- `isHead` is computed by asking Register `register.isHeadOf(memberId)`.

## Endpoints

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/v1/auth/session` | public | `{ firebaseIdToken, client: "WEB" \| "MOBILE" }` → `{ principal, token? }` (token only for MOBILE); sets cookie for WEB |
| GET | `/v1/auth/me` | principal | → `{ principal }` |
| DELETE | `/v1/auth/session` | principal | → `204`; revokes this session, clears cookie |

`principal` response shape:

```ts
{ kind: "APPLICANT", phoneE164: string, registrationId: string }
| { kind: "MEMBER", phoneE164: string, memberId: string, familyPublicId: string, roles: Role[], isHead: boolean }
```

Module error codes: `FIREBASE_TOKEN_INVALID` 401, `PHONE_BELONGS_TO_ARCHIVED_MEMBER` 403, `SESSION_EXPIRED` 401.

## Default rate limits

| Name | Key | Limit |
|---|---|---|
| `session.create.ip` | client IP | 30 / hour |
| `session.create.phone` | phone from the verified token | 10 / hour |
| `registration.paymentOrder` | registrationId | 5 / hour |
| `registration.familyCheck` | session | 30 / hour |
| `registration.submit` | registrationId | 10 / hour |
| `romanize` | session | 60 / hour |
| `media.upload` | principal | 20 / hour |
| `officer.*` | memberId | 600 / hour |

Client IP is the first address of `X-Forwarded-For` as set by Caddy; configure Express `trust proxy` to exactly one hop.

## Public interface (`index.ts`)

```ts
promoteToMember(tx, registrationId: string, memberId: string): Promise<void>
revokeAllForMember(tx, memberId: string, reason: RevokeReason): Promise<number>
grantRole(tx, memberId: string, role: Role, grantedBy: string): Promise<void>
revokeRole(tx, memberId: string, role: Role, revokedBy: string): Promise<void>
rolesOf(memberId: string): Promise<Role[]>
```

## Required tests

- A valid fake token for an unknown phone yields an Applicant principal and a Registration.
- A token with `sign_in_provider: "password"`, a non-Indian number, or `auth_time` 11 minutes old is refused.
- Web session: cookie set with `HttpOnly`, `Secure`, `SameSite=Lax`; body has no token. Mobile session: token in body, no cookie.
- A cookie-authenticated `POST` without an allowed `Origin` → 403; with it → passes.
- `revokeAllForMember` → the next request with that cookie → 401.
- invariant 25: a second Registration for a phone already held by a Member cannot exist (sign-in yields the Member principal, never an Applicant).
- Archived Member's phone → `PHONE_BELONGS_TO_ARCHIVED_MEMBER`.
- Session idle past TTL (fake clock) → 401; activity within TTL extends expiry.
- Rate limit: the 11th session creation for one phone in an hour → 429 with `Retry-After`; state survives an app restart (new `createApp` against the same DB).
