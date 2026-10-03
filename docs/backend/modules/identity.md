# Module: Identity

Owns sign-in, sessions, principals and roles. Stage 1.

## What it does

A person proves control of a phone by requesting a 6-digit OTP delivered via SMS (`POST /v1/auth/otp`) and submitting it for verification (`POST /v1/auth/session`). The API verifies the code against an active HMAC-SHA256 hashed `OtpChallenge`, then issues its own opaque session (ADR-0033).

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
model OtpChallenge {
  id         String    @id // uuid v7
  phoneE164  String
  codeHash   String    // hmac-sha256(otp, OTP_HMAC_KEY), hex
  attempts   Int       @default(0)
  expiresAt  DateTime
  consumedAt DateTime?
  createdAt  DateTime  @default(now())
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
- Sliding expiry: on each authenticated request, if `lastSeenAt` is older than 1 hour, update `lastSeenAt` and extend `expiresAt` to now + TTL (web 30 days, mobile 90 days). The resolver returns whether it extended the session; HTTP middleware renews the cookie only for an extended cookie session. Idle beyond TTL → expired; revoked or expired web cookies are cleared and treated as anonymous so the user can sign in again.
- A request presenting both a cookie and a bearer token is rejected `400 VALIDATION_FAILED`.

## Rules

1. **OTP generation & verification (ADR-0033)**:
   - Request OTP (`POST /v1/auth/otp`): Generates a 6-digit cryptographic code (TTL 300s, max 5 attempts, 30s resend cooldown). Hashed via HMAC-SHA256 (`OTP_HMAC_KEY`) and stored in `OtpChallenge`. Delivered via MSG91 Flow API (or console in dev).
   - Session creation (`POST /v1/auth/session`): Verifies `authentication: { kind: "SMS_OTP", phoneE164, otp }` against the active unconsumed challenge. Code mismatch → `401 OTP_INVALID`. Exceeded attempts (≥5) → `429 OTP_ATTEMPTS_EXCEEDED`. Expired code → `401 OTP_INVALID`.
2. **Principal resolution** on session creation, by `phone_number`:
   - An ACTIVE Member holds the phone → Member principal.
   - An ARCHIVED Member holds the phone → `403 PHONE_BELONGS_TO_ARCHIVED_MEMBER`.
   - Otherwise → Applicant principal. Ask Registration for the phone's Registration: `registration.openForPhone(phone)` (see `registration.md` for which Registration is resumed and which is abandoned).
3. **Upgrade in place**: when a Registration completes, Registration calls `identity.promoteToMember(tx, registrationId, memberId)`, which sets `memberId` and clears `registrationId` on every live session of that phone. The client keeps its cookie/token.
4. **Revocation**: `identity.revokeAllForMember(tx, memberId, reason)` — called by Erasure, Archival and Officer actions. Takes effect on the very next request (sessions are looked up on every request; no caching).
5. **Roles** are read from `MemberRole` on every request (one indexed query) so a grant or revoke is immediate.

## Middleware (`src/http/auth.ts`)

- `IdentityService.resolve` returns `{ principal, sessionRefreshed } | null` and does not receive or write an Express `Response`. `authenticate` attaches the principal and owns cookie renewal or expiration; missing credentials → `req.principal = null`, while invalid or expired credentials are anonymous and an invalid web cookie is cleared.
- `requirePrincipal`, `requireApplicant`, `requireMember`, `requireRole(role)`, `requireHead` → `401 UNAUTHENTICATED` / `403 FORBIDDEN`.
- `isHead` is computed by asking Register `register.isHeadOf(memberId)`.

## Endpoints

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/v1/auth/otp` | public | `{ client: "WEB" \| "MOBILE", phoneE164 }` → `202`; `{ expiresInSeconds: 300, resendAfterSeconds: 30 }` |
| POST | `/v1/auth/session` | public | `{ client: "WEB" \| "MOBILE", authentication: { kind: "SMS_OTP", phoneE164, otp } }` → `201`; `{ principal, token? }` (token only for MOBILE); sets cookie for WEB |
| GET | `/v1/auth/me` | principal | → `{ principal }` |
| DELETE | `/v1/auth/session` | principal | → `204`; revokes this session, clears cookie |

`principal` response shape:

```ts
{ kind: "APPLICANT", phoneE164: string, registrationId: string }
| { kind: "MEMBER", phoneE164: string, memberId: string, familyPublicId: string, roles: Role[], isHead: boolean }
```

Module error codes: `OTP_INVALID` 401, `OTP_ATTEMPTS_EXCEEDED` 429, `OTP_DELIVERY_FAILED` 502, `RATE_LIMITED` 429, `VALIDATION_FAILED` 400, `PHONE_BELONGS_TO_ARCHIVED_MEMBER` 403, `SESSION_EXPIRED` 401.

## Default rate limits

| Name | Key | Limit |
|---|---|---|
| `otp.send.phone` | phone number | 5 / hour |
| `otp.send.ip` | client IP | 20 / hour |
| `session.create.ip` | client IP | 30 / hour |
| `session.create.phone` | phone from verified OTP | 10 / hour |
| `registration.paymentOrder` | registrationId | 5 / hour |
| `registration.familyCheck` | session | 30 / hour |
| `registration.submit` | registrationId | 10 / hour |
| `romanize` | session | 60 / hour |
| `media.upload` | principal | 20 / hour |
| `officer.*` | memberId | 600 / hour |

Login IP rate limits use Express `request.ip`, not a caller-selected `X-Forwarded-For` entry. Express trusts exactly one proxy hop; Caddy overwrites `X-Forwarded-For` with its remote peer address. The API ports are loopback-bound in deployment and must not be exposed directly; another proxy must enforce the same overwrite contract.

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
