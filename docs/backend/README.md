# Backend build plan — Stage 1 and Stage 2

The plan an agent follows to build the API (`Agrawal_Backend/`): the Express API that the React web client (`Agrawal_Frontend/apps/web`) and the Flutter app (`Agrawal_App/`) both call. It covers Stage 1 (22 September 2026) and Stage 2 (11 October 2026). Stage 3 is out of scope; where a Stage 3 feature constrains a Stage 1–2 decision, the constraint is stated in place.

**Vocabulary is `CONTEXT.md`.** Every term in capitals here — Applicant, Registration, Member, Family, Head of Family, Donor, Notice, Officer — means exactly what the glossary says. Name code after it: a `Registration` model, not `Signup`; `headMemberId`, not `ownerId`. When the code and the glossary disagree, the glossary wins and the disagreement is a bug.

**Decision record.** The canonical decisions behind this plan live in `Agrawal_App/docs/adr/`. The design session of 18 September 2026 is recorded in ADR-0022 (Stage 1 moved to 22 September with reduced scope; image screening deferred), ADR-0023 (every adult pays; duplicate heads refused and refunded after payment; refunds on Registrations that don't complete; one phone per Member), ADR-0024 (backend architecture) and ADR-0025 (Blood SOS widens by place instead of distance). Round 7 and Play-readiness sessions added ADR-0026, ADR-0027 (grievance mailbox: `help.agrawal.app@gmail.com`), and ADR-0028 (web deployment on AWS; Vercel retired).

## How to use this plan

1. Read `architecture.md` in full before writing any code. It fixes the stack, the repository layout, the module boundary rule and every cross-cutting convention (errors, auth, idempotency, jobs, rate limits, the Processing Record, testing).
2. Work the milestones below **in order**. Each milestone names the module files to read; read them before starting it.
3. A milestone is done only when every line of its **done when** list is true and verified — tests passing is necessary, not sufficient.
4. Commit at checkpoints per `Agrawal_App/docs/agents/checkpoints.md`. The API has its own CI and deploy; web surfaces deploy to AWS (ADR-0028), so the root `npm run build` in `Agrawal_Frontend/` must still pass.

## Reference files

| File | Read when |
|---|---|
| [`architecture.md`](architecture.md) | Always, first. |
| [`modules/identity.md`](modules/identity.md) | Sessions, sign-in, roles, CSRF, rate limits. |
| [`modules/payments.md`](modules/payments.md) | Anything touching Razorpay, refunds, Payment Identity. |
| [`modules/registration.md`](modules/registration.md) | Applicants, Registrations, founding, joining, Head confirmation, Family ID minting. |
| [`modules/register.md`](modules/register.md) | Members, Families, profile, consents, Nominee, visibility projections, directory, succession, Erasure. |
| [`modules/media.md`](modules/media.md) | Image upload, storage, visibility, screening. |
| [`modules/officer.md`](modules/officer.md) | The Officer's routes, flags, the Processing Record. |
| [`modules/notifications.md`](modules/notifications.md) | FCM device tokens, sending, delivery records. (Stage 2) |
| [`modules/noticeboards.md`](modules/noticeboards.md) | Shok Sandesh, Archival Requests, Business Listings, Reports, suspensions, posting cap, text checks. (Stage 2) |
| [`modules/blood-sos.md`](modules/blood-sos.md) | Blood SOS, Donors, widening, Donor Reach. (Stage 2) |
| [`modules/events.md`](modules/events.md) | Events, Organisers, Event Passes, gate manifests, scan sync. (Stage 2) |
| [`open-questions.md`](open-questions.md) | Before hard-coding any default marked *(open)*. |

## Invariant enforcement map

Every invariant in `CONTEXT.md` has one owning module that enforces it and at least one test named after it (`it('invariant 6: …')`).

| # | Invariant (short) | Owner | Enforced by |
|---|---|---|---|
| 1 | Family exists only after a completed Registration Payment | Registration | Founding completion requires a `CAPTURED` payment on the Registration |
| 2 | Family ID permanent, never reissued | Registration | Counter-per-pincode minting in the completion transaction; no update path on `Family.publicId` |
| 3 | Exactly one Family Link, never zero | Register | Member and Family Link created in one transaction; unique `memberId` on `FamilyLink`; no delete path except Erasure |
| 4 | Gotra held by Family, one of 18, immutable | Register | `Gotra` enum; no update path; joiners inherit |
| 5 | Exactly one Head at all times; succession | Register | `Family.headMemberId` non-null while Family active; succession in the same transaction as Head's Erasure or Archival |
| 6 | One identity heads at most one Family | Payments + Registration | Founding refused on `HeadAnchor` hit; missing identity flagged |
| 7 | Only adults; minors only as a headcount | Registration, Events | Age ≥ 18 at submission; `minorsCount` integer on Event Pass only |
| 8 | Adults never entered by someone else; Head confirms links | Registration | Only the Applicant's own session submits; joining completes only on Head approval |
| 9 | Directory holds living Members only | Register | Directory queries filter `status = ACTIVE` |
| 10 | Publication never archives | Noticeboards | Shok Sandesh publish opens an Archival Request; never writes Member status |
| 11 | Explicit imagery removed; refused at upload once screening exists | Media | `UNSCREENED` images visible to uploader only; screening fail-closed when enabled |
| 12 | Commercial Notices publish only after Posting Fee | Noticeboards | Publication triggered only by a captured payment |
| 13 | Reports count distinct Families, never the author's own | Noticeboards | Count `DISTINCT reporterFamilyId WHERE reporterFamilyId <> authorFamilyId` |
| 14 | Suspension visible, history preserved, ends by expiry or Officer | Noticeboards | `Suspension` returned on `/me`; no content deleted; lift endpoint |
| 15 | Blood SOS reports Donor Reach; widens | Blood SOS | Reach = count of alerts FCM accepted; density floor |
| 16 | Phone visible to linked Family (and chosen Friends) only | Register, Noticeboards | Projections; text check refuses personal numbers in Notices |
| 17 | Erasure purges immediately; statutory records restricted | Register | Erasure procedure + `restricted` schema + purge job |
| 18 | Officer path to reverse every automated refusal | Officer | Every refusal has a matching Officer endpoint |
| 19 | Event Pass one Member one Event, offline verify | Events | Unique `(eventId, memberId)`; Ed25519 signature |
| 20 | Blood Group displayed to nobody | Register | No projection except SELF includes it |
| 21 | Name in every script supplied, never machine-generated | Register, Registration | Derived Latin stored only as `nameEnSearchKey` |
| 22 | One audience per field; unnamed = Member-only | Register | Projection allow-lists per viewer relation |
| 23 | Event Pass never carries a charge | Events | No payment purpose for passes |
| 24 | Nominee read by Member, Officer on death/Archival, logged | Register, Officer | Officer read endpoint requires reason + writes Processing Record |
| 25 | A phone number belongs to at most one Member | Identity, Register | Unique `Member.phoneE164` (active and archived); Registration refuses a phone already held |

## Milestones

Today is 21 September; Stage 1 is 22 September. The Stage 1 and Stage 2 backend source is built (commit `efb535a`, 20 September). What remains of M0–M13 is infrastructure, Operator facts and live verification — see [`docs/REMAINING BACKEND WORK.md`](../REMAINING%20BACKEND%20WORK.md). M0–M5 are Stage 1; M6–M13 are Stage 2 and must be feature-complete on staging by **1 October** so the Flutter store builds can be submitted at the start of review.

### Stage 1 — registration live on 22 September

**M0 — Foundations.** Read `architecture.md`.
- Scaffold `Agrawal_Backend` exactly as the layout in `architecture.md`: TypeScript strict, Express 5, zod, Prisma pinned, pg-boss, pino, vitest.
- Config loader that fails fast on a missing variable; `/healthz` and `/readyz`.
- Error envelope, request IDs, the `validate()` middleware, OpenAPI generation to `Agrawal_Backend/openapi.json`.
- Docker Compose for local Postgres; the test harness that runs against a real database.
- GitHub Actions: typecheck, lint, test, OpenAPI drift check.
- Staging on AWS: EC2 + RDS database `agrawal_staging`, Caddy TLS, deploy on push to `main` (workflow at `Agrawal_Backend/.github/workflows/api.yml`).

Done when: `curl https://<staging-api-host>/readyz` returns 200 with the database reachable; CI is green on a PR; `openapi.json` regenerates identically in CI.

**M1 — Identity.** Read `modules/identity.md`.
- Backend SMS OTP exchange (`POST /v1/auth/otp` and `POST /v1/auth/session`, ADR-0033), opaque sessions (cookie for web, bearer for mobile), principals (Applicant / Member), roles, CSRF origin check, Postgres-backed rate limiter.

Done when: a phone on the staging web origin signs in with a real OTP and `GET /v1/auth/me` returns an Applicant principal; revoking the session row logs the phone out on the next request; every test in identity's list passes.

**M2 — Payments and founding.** Read `modules/payments.md`, `modules/registration.md`.
- Registration lifecycle up to founding completion; Razorpay order creation, webhook ingestion, reconciliation job, Payment Identity extraction and `HeadAnchor`; founding completion with Family ID minting; consents and disclosure recorded; romanization endpoint.

Done when: on staging with Razorpay **test** keys, a phone completes OTP → ₹1 → full form → Family ID, and the Family row exists only after the `payment.captured` webhook; a second founding attempt paid from the same test VPA is refused and refunded; the webhook replayed twice changes nothing the second time.

**M3 — Joining and Head confirmation.** Read `modules/registration.md`.
- Join route, Family ID check, pending link requests for the Head, approve/decline, 14-day expiry, abandonment, every refund path.

Done when: two phones on staging — one founds, one joins with that Family ID — and the joiner becomes a Member only after the Head approves on the web; a declined join and an expired join (clock advanced in test) are each refunded exactly once.

**M4 — Member self-service, media, Officer.** Read `modules/register.md` (Stage 1 parts), `modules/media.md`, `modules/officer.md`.
- `/v1/me` read and edit, consents, Nominee, erasure request; image upload (unscreened, uploader-only visibility), family photo; Officer role, flag queue, Officer-executed Erasure, image review and removal, Processing Record.

Done when: the Officer, signed in on staging, clears a flag, removes an image (the Member sees the reason on `/v1/me`), and erases a Member — after which the Member's session is dead, their profile and images are gone, and their payment and consent rows sit in `restricted` with a `retainUntil`; each of those actions has a Processing Record row that cannot be updated or deleted by the app's database role.

**M5 — Production cutover.** Read the Deployment section of `architecture.md`.
- Production database `agrawal_prod`, production DLT registration and Amazon SNS setup (ADR-0034), Razorpay **live** keys and live webhook secret, UPI Intent confirmed enabled on the Razorpay account, secrets in SSM, tagged release.

Done when: on production, a real phone pays a real ₹1, founds a Family, and the payment's `vpa` is recorded as its Payment Identity (if `vpa` is absent, record that fact in `open-questions.md` — it decides how many founders get flagged); that test Member is then erased by the Officer and the ₹1 refunded; RDS automated backups are on with 7-day retention.

### Stage 2 — everything on staging by 1 October, live 11 October

**M6 — Register, Stage 2.** Read `modules/register.md`.
- Directory search (both scripts, trigram), Family and Member profiles through projections, invite codes, self-service Erasure, Head succession, Nominee prompt, Archival state on Member.

Done when: every row of invariant 22's audience table has a passing projection test for SELF, FAMILY and SAMAJ viewers; a Head's self-Erasure hands the Family to their Nominee in the same transaction.

**M7 — Notifications.** Read `modules/notifications.md`.

Done when: the Flutter app on a real Android device registers a token and receives a test push sent through the module's interface; an invalid token is deleted after its first failed send.

**M8 — Noticeboards: Shok Sandesh, Archival, Reports.** Read `modules/noticeboards.md`.

Done when: a Shok Sandesh linked to a Member opens an Archival Request that the deceased's Family confirms (Member archived, Head succeeded, directory no longer lists them); five reports from five Families other than the author's hide a Notice and suspend its author for seven days; a Notice containing a personal mobile number is refused with `NOTICE_CONTAINS_PHONE`.

**M9 — Business Listings.** Read `modules/noticeboards.md`, `modules/payments.md`.

Done when: a listing publishes only after its ₹49 test payment is captured, expires after 180 days (clock advanced in test), and a renewal payment extends it.

**M10 — Blood SOS.** Read `modules/blood-sos.md`.

Done when: a request raised for a hospital pincode alerts city-tier exact-match Donors immediately, widens to district then state at 30-minute steps (clock advanced in test), applies the density floor when too few Donors match, never alerts a snoozed Member, and reports a Donor Reach equal to the number of alerts FCM accepted.

**M11 — Events and passes.** Read `modules/events.md`.

Done when: a pass QR produced by the API verifies with only the public key and no network (a unit test using `node:crypto` alone); a pass scanned on two devices offline and then synced produces one admission conflict for the Organiser.

**M12 — Image screening.** Read `modules/media.md`.
- Sightengine adapter, fail-closed; flip `IMAGE_SCREENING_ENABLED=true`; screen the backlog of `UNSCREENED` images.

Done when: screening is on in production, the backlog is empty, and a timed-out screening call leaves the image `REJECTED` with reason `SCREENING_UNAVAILABLE`. If this milestone cannot finish by 11 October, `IMAGE_SCREENING_ENABLED` stays `false` and photos stay uploader-only — that is the fallback, not a failure.

**M13 — Stage 2 hardening.** Read the Security checklist in `architecture.md`.

Done when: every item on the security checklist is ticked with evidence; a restore of the staging database from an RDS snapshot has been rehearsed; the generated Dart client builds inside the Flutter app.
