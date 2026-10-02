# Open questions

Items marked *(open)* in the module and architecture docs. Each must be resolved before the value is hard-coded. Do not guess; raise to the Operator or flag in a commit message.

Operator Decisions Round 7 (ADR-0026, 21 September 2026) answered this file's former items 1–3 and 5–11. What follows is what is still outstanding; the resolved items are listed at the bottom for cross-reference.

## Operator facts still missing

1. ~~The Officer's grievance email address.~~ **Resolved 21 September 2026 (ADR-0027):** the mailbox is `help.agrawal.app@gmail.com`, under the Operator's control. The consent and privacy notices can now publish the channel; the 30-day response SLA stands (ADR-0017).
2. **The Google Cloud project** for `romanizeText`. A GCP project with the Cloud Translation API enabled, a service account key, and billing. Needed by M2.
3. **UPI VPA availability on production** — Razorpay's docs do not promise `vpa` is always present and unmasked for UPI Intent / QR payments. M5's done-when says: if `vpa` is absent on the first real ₹1 payment, record that fact here. The answer determines how many founding registrations get flagged as `NO_PAYMENT_IDENTITY` versus how many are silently anchored.

## Design items still open

4. **`feature-list.md` re-sign.** It still lists directory lookup and AI photo screening under Stage 1 (moved by ADR-0022), and the 25/50/100 km radius ladder under §2.5 (replaced by ADR-0025). ADR-0026 adds a third divergence: the Stage 1 brief's "Agarwal Samaj" spelling mandate is superseded — the community's Latin name is "Agrawal" (ADR-0026 §4). Either edit the list and have the Operator re-sign, or leave it and have the ADRs prevail.

## Resolved by Operator Decisions Round 7 (ADR-0026, 21 September 2026)

- **Registered company name** (was item 1): the fiduciary is Mr Rahul Kumar Agrawal, the proprietor personally; no separate company name (§1).
- **Officer grievance contact** (was item 2): email only; the address remains item 1 above (§2).
- **Production domain** (was item 3): `agrawal.app`, with `register.` and `api.` subdomains; settles "Agarwal vs Agrawal" in favour of "Agrawal" (§3–4).
- **`RETENTION_DAYS_PAYMENTS`** (was item 5): 2920 days — eight years, covering GST's 72 months and the income-tax reassessment window (§5). `.env.example` and `architecture.md` updated.
- **Family photo audience** (was item 6): closed default confirmed — Member and their own Family see it; the wider Samaj never does (§6).
- **Blood SOS app-only fields** (was item 8): the Operator approved API support for `urgency`, `patientRelation` and `hospitalArea`; urgency remains display-only (§7). **Implementation open:** current source does not accept, store, or return these fields.
- **Blood SOS pincode-failure fallback** (was item 9): the requester's own city, district and state, as ADR-0025 §6 specifies (§8).
- **Blood SOS tuning** (was item 10): `DONOR_COOLDOWN_DAYS` stays 90 flat; `DONOR_DAILY_ALERT_CAP` (3) and `SOS_DENSITY_FLOOR` (5) stay placeholders, retuned after real usage (§9).
- **Event Pass re-claim** (was item 11): allowed by decision — a `MEMBER_CANCELLED` pass must reactivate with a fresh signature; Officer/erasure/archival revocations stay final (§10). **Implementation open:** the service still rejects an existing pass row.
- **Per-owner media quota** (was in `REMAINING BACKEND WORK.md` §2): approved limit of 30 live images per owner, count-based (§11). **Implementation open:** upload quota enforcement and boundary tests are absent.