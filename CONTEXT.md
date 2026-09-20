# Agrawal Samaj Community App

The domain language of a community app for the Agrawal Samaj: a verified register of member households, a set of community noticeboards, and the safety and privacy rules that govern them.

This file is a **glossary and a statement of invariants** — nothing else. It carries no vendor names, no tuning thresholds, no statute references and no prices. Those live in `docs/adr/`, which is the decision record; this file records only what things are called and what must always be true. Where an invariant exists because of a decision, the deciding ADR is named.

Scope markers name the delivery stage a term becomes real in (ADR-0013, re-dated by ADR-0022): **Stage 1** — 22 September 2026, the registration website; **Stage 2** — 11 October 2026, Agrasen Jayanti launch; **Stage 3** — 31 October 2026, the complete feature set; **Post-Stage 3** — deliberately deferred past all three. An unmarked term is present from Stage 1. Stage contents are listed in `feature-list.md`, which is the signed scope (ADR-0016).

---

## Language

### Membership

**Family**:
A registered household in the Samaj, holding one Family ID and one Gotra, with one Member designated as Head of Family. Has no limit on the number of Members.
_Avoid_: household account, family group

**Member**:
An adult individual registered in the Samaj, linked to a Family. The directory holds living Members only.
_Avoid_: user, profile, account

**Head of Family**:
The Member who created the Family and who authorises links into it. Exactly one per Family. The role is transferable to another adult Member of the same Family (Head Transfer, Stage 3).
_Avoid_: owner, admin

**Family Link**:
The relationship binding a Member to a Family. Through Stage 3 a Member holds exactly one, of kind `BIRTH`. A Member never holds zero links.
_Avoid_: membership, join

**Marital Link** (Post-Stage 3):
A second Family Link of kind `MARITAL`, proposed by an inviter and inactive until the spouse accepts. Deferred past all three stages along with dual-family membership, marriage-date capture, Gotra precedence and voluntary unlinking (ADR-0007, ADR-0013).

**Family ID**:
The permanent public identifier of a Family, in the form `AGR-[PINCODE]-[SEQ]`, where SEQ is a five-digit sequence counted separately within each pincode. Issued once, on Family creation, and never reissued or changed — it survives relocation, so the pincode records where the Family registered, not where it now lives. The `AGR-NRI-[SEQ]` form is reserved for overseas households but is not issued before Stage 3: registration is India-only through Stage 2 (ADR-0019).
_Avoid_: registration number, family code

**Gotra**:
The patrilineal lineage of a Family, chosen from the eighteen Gotras of Maharaja Agrasen and immutable thereafter: Garg, Goyal, Goyan, Bansal, Kansal, Singhal, Jindal, Tingal, Mohan, Dharan, Madhukul, Bindal, Mittal, Tayal, Mangal, Airan, Nangal, Kuchhal. Held by the Family; a Member's Gotra is the Gotra of their Family.
_Avoid_: clan, surname, caste

**Nominee**:
A Member named by another Member to exercise that Member's data rights on death or incapacity, and holding first priority in Head of Family succession. Optional at registration and prompted once the Family holds a second adult Member — the first Head of a Family has no other Member to name. Read by the naming Member alone, and by the Officer only on a confirmed death or Archival request; the named Nominee is not notified (ADR-0018). The Nominee's exercise of another Member's data rights is Stage 3.
_Avoid_: next of kin, beneficiary

### Registration and identity

**Applicant**:
A person who has verified their phone and is part-way through registering, but is not yet a Member. An Applicant appears nowhere in the register — not in the directory, not in any Family, not in any count of Members.
_Avoid_: pending member, draft member, user

**Registration**:
An Applicant's application to become a Member, either by founding a Family or by joining an existing one. It advances through verification, payment and submission; a founding Registration completes on submission, a joining Registration completes only when the receiving Family's Head confirms. The Applicant becomes a Member at completion and not before. A Registration that never completes — declined by the Head, left unconfirmed past its expiry, or abandoned before submission — has its Registration Payment refunded. An abandoned Registration is not resumed: the Applicant starts a fresh one (ADR-0023).
_Avoid_: signup, onboarding, application form

**Registration Payment**:
A completed payment made by every registering adult — the founder of a Family and each adult joining one — that both funds the app and proves a live human is registering. Its purpose is friction, not revenue. The amount is set by the Operator and is not part of this domain; each payment record stores the amount actually charged at the time (ADR-0008, ADR-0023).
_Avoid_: registration fee, ₹99, onboarding charge, subscription

**Payment Identity**:
The payment instrument that made a Registration Payment, used as the anchor that prevents one person heading several Families. It becomes known only once the payment has been made, never before. Every Registration Payment's identity is recorded, but only a founding Registration is refused on a repeat: a joining adult commonly pays from a relative's instrument, so a joiner whose Payment Identity anchors the Head of a *different* Family is flagged for the Officer, never refused (ADR-0023).
_Avoid_: bank details, UPI ID

**Duplicate Head Attempt**:
An attempt to head a second Family from an identity already heading one. An exact Payment Identity repeat is refused as soon as the payment reveals it, and the Registration Payment is refunded; a payment that reveals no usable Payment Identity, and any weaker resemblance, is flagged for the Officer rather than refused (ADR-0010, amended by ADR-0023).

**Vouch** (Stage 3):
An attestation by an existing Head of Family that a registering person is genuinely of the Samaj, available as an alternative to document-based verification and rate-limited to curb abuse. Stage 1 and Stage 2 identity rests on Phone OTP, the Registration Payment and the Officer's clearance of flagged duplicates instead (ADR-0013).
_Avoid_: referral, invite

**Invite**:
The mechanism by which an existing Member brings another adult into a Family. Adults always self-register — a Head cannot type another adult's personal details — and a link is created only after the receiving Family's Head confirms. From Stage 1 a joining adult supplies the Family ID themselves; the Member-initiated invite that carries them into that flow is Stage 2.
_Avoid_: add member, import

### Noticeboards

**Notice**:
A post authored by a Member to one of the community boards: Shok Sandesh and Business from Stage 2; Jobs, Events and Announcements from Stage 3. Subject to a daily per-Member posting cap, to Reports, and to an automated check that refuses blocked words and refuses a personal phone number in the text — a Notice is never a route around invariant 16. A Business Listing's own business number is exempt: it is a business fact, deliberately public.
_Avoid_: post, listing, ad

**Commercial Notice**:
A Notice that carries a Posting Fee and is published only after that payment completes. Both the Stage 2 Business Listing board and the Stage 3 Jobs board are Commercial Notices (ADR-0012, ADR-0013, ADR-0016).
_Avoid_: paid post, sponsored post

**Posting Fee**:
A charge on Commercial Notices, existing to make bulk advertising uneconomic. Amount set by the Operator, not part of this domain; refunded only when publication fails for technical reasons, never on moderation rejection (ADR-0008).
_Avoid_: post fee, ₹49

**Business Listing** (Stage 2):
A Commercial Notice offering a Samaj member's business to the community — name, category, city, contact details, photo — browsable and searchable by category and city. Publishes only after its Posting Fee completes, and runs 180 days before expiring, renewable by its author (ADR-0016).
_Avoid_: business ad, sponsored listing, directory entry

**Shok Sandesh**:
An obituary Notice announcing a death in the Samaj. Publishing it announces the death; it does not by itself change the deceased Member's record (see Archival).
_Avoid_: death notice, obituary post

**Archival**:
The transition of a deceased Member's record out of the living directory. Requires confirmation by an adult Member of the deceased's own Family, or by the Officer — never by publication alone (ADR-0009). Where no family confirmation arrives within a fixed period, the record escalates to the Officer as a task; it is never archived automatically (ADR-0016).
_Avoid_: deletion, deactivation

**Archival Request** (Stage 2):
The open question "has this Member died?", put to the adult Members of the deceased's own Family. Opened when a Shok Sandesh is linked to a Member's record; resolved by a family confirmation or, failing one within the fixed period, by the Officer. A Shok Sandesh not linked to a Member opens none and changes nothing in the register.
_Avoid_: death report, archive task

**Birthday & Anniversary Board** (Stage 3):
A computed board, not authored content: it is generated daily from Member dates of birth and anniversaries and rendered as its own feed. Each Member may opt out.
_Avoid_: birthday notices, celebrations feed

**Blood SOS** (Stage 2):
An urgent request for a blood donor, raised for a hospital and notifying matching Donors near it, widening its reach over time — from the hospital's city, to its district, to its state. Nearness is by place, never by distance: the register holds no coordinates. One active request per Member; exempt from the daily posting cap; closed when the requester marks it fulfilled (ADR-0025).
_Avoid_: blood request, emergency post

**Donor** (Stage 2):
A Member whose blood-group Consent Toggle is on, who has not snoozed Blood SOS alerts, and who is not within the donation cooldown after a donation they reported. Only Donors are matched to a Blood SOS, at every stage of its widening: a snoozed or cooling-down Member is never reached, not even by the city-wide fallback. The Consent Toggle covers every stage; there is no separate city-wide consent (ADR-0025).
_Avoid_: volunteer, blood donor (for any Member merely holding a Blood Group)

**Donor Reach**:
The number of Donors a Blood SOS actually notified, shown to the requester. A Donor counts as notified when an alert was accepted for delivery to at least one of their devices — a claim about sending, never about being seen; a Donor with no reachable device is not counted. Where too few matching Donors exist, the request widens immediately to all Donors in the city irrespective of blood group rather than notifying almost nobody (ADR-0011, ADR-0025).
_Avoid_: match count

**Report** (Stage 2):
A Member's flag that a Notice breaches community standards. Reports from a threshold number of distinct Families — never counting the author's own Family — hide the Notice and suspend its author's posting ability for a fixed period; message history is preserved and the suspension is visible to the author, never silent.
A Blood SOS can be reported to the Officer but is never hidden by Reports, so bad-faith reports cannot silence an emergency.
_Avoid_: flag, complaint, shadowban

### Events and passes

**Event Pass** (Stage 2):
A Member's admission to one Event, verified by an Organiser at the gate. One pass per Member per Event, non-transferable, invalid once the Event ends, and verifiable without network because a hall may have no signal. Accompanying minors are carried as a headcount on the Head of Family's pass, never as individually scanned passes (ADR-0013). Only the app issues a pass; a gate device can verify one but never create one. Because gates may be offline, a pass admitted twice at different gates is recorded for the Organiser after the fact, never blocked. Passes are signed by the server, never on the device (ADR-0024).
_Avoid_: ticket, QR code, invite

**Organiser** (Stage 2):
A Member the Operator designates to create Events and verify Event Passes at the gate, intended for representatives of the Samaj committee. Until any are designated, only the Operator creates Events (ADR-0016).
_Avoid_: host, event admin, committee

### Chat and groups (Stage 3)

**Family Chat**:
A private conversation among the Members of one Family.

**Auto-Group**:
A community conversation a Member belongs to by attribute rather than by invitation — one per Gotra and one per city. Changing city in a profile moves the Member between city Auto-Groups automatically. Text-only.
_Avoid_: channel, community group

**Contact Request**:
A request to open a one-to-one conversation with a Member who has hidden their phone number, which connects the two without revealing it.
_Avoid_: message request, connect

**Handle**:
A unique name by which a Member can be found and contacted without exposing their phone number.
_Avoid_: username, ID

### Friends

**Friend**:
A Member outside your Family with whom a Friend Request has been accepted. Friendship alone shares nothing beyond what the wider Samaj already sees (ADR-0021).
_Avoid_: connection, follower, contact

**Friend Request**:
A request from one Member to become another Member's Friend. It never carries contact details, and accepting it opens a Contact Share choice for the acceptor.
_Avoid_: connect request, invite

**Contact Share**:
A Member's per-Friend, per-field choice to show that one Friend their phone number or their email. Off by default, and revocable at any time. Removing the Friend withdraws it in both directions (ADR-0021).
_Avoid_: publish, make public

### Governance and privacy

**Officer**:
The named human answerable for data and verification: the published contact for grievances, and the holder of the power to reverse automated outcomes — lifting suspensions, overriding wrongly rejected images, clearing flagged duplicate registrations and reverting a false Archival — and of the power to remove an explicit image a Member has uploaded, telling the Member why (ADR-0022). Removing an image never removes the Member. Appointed by the Operator, not by the Samaj. The Officer's clearance of a flagged duplicate registration is present from Stage 1; the single console gathering every reversal in one place is Stage 3.
_Avoid_: admin, moderator, superuser

**Operator**:
The party that owns, runs and pays for the app, and therefore sets its prices, appoints the Officer and bears the obligations of a data fiduciary. The Operator is not the Samaj and holds no office in it: the app is a private product serving the community, not an instrument of the community's committee.
_Avoid_: the committee, the Samaj, admin, us

**Consent Toggle**:
An independently revocable permission granted by a Member covering directory listing, blood group and photo. Withdrawing directory listing withdraws membership itself, and so triggers Erasure. All three are captured from Stage 1. A chat toggle is not captured at registration: it is added when community chat ships at Stage 3, and chat is off for every Member until then. Phone visibility is not among them: no setting publishes a phone number, so there is nothing to grant or revoke (invariant 16, ADR-0018, ADR-0020).
_Avoid_: setting, preference

**Payment Retention Disclosure**:
Notice to the Member that payment records are retained for a statutory period. It is a disclosure, not a Consent Toggle, because it cannot be withdrawn while the retention obligation stands.
_Avoid_: payment consent

**Erasure**:
The removal of a Member at their request, in two stages: everything member-visible — profile, personal details, photo, messages — is purged immediately, while payment records, consent history and processing logs are held in restricted storage for a statutory period before final deletion. At Stage 1 the Officer executes the request; self-service Erasure is Stage 2 (ADR-0013).
_Avoid_: delete account, GDPR delete

**Historical Content**:
Notice and obituary text authored by a Member, retained as a community record after that Member's Erasure or death, with personal details scrubbed.
_Avoid_: archive, old posts

---

## Invariants

1. **A Family exists only after a completed Registration Payment.** Amount is not part of this rule (ADR-0008).
2. **A Family ID belongs to exactly one Family, permanently.** Never reissued, never changed by relocation (ADR-0001).
3. **A Member holds exactly one Family Link through Stage 3, and never zero.** Dual membership and Marital Links are Post-Stage 3 (ADR-0007, ADR-0013).
4. **Gotra is held by the Family, is one of the eighteen, and never changes** (ADR-0001).
5. **A Family has exactly one Head of Family at all times.** On the Head's death or Erasure, the Nominee succeeds, failing which the next-oldest adult Member; with no adult Members remaining the Family is archived — frozen, non-postable, retained for history (ADR-0003, ADR-0005).
6. **One identity heads at most one Family.** Exact Payment Identity repeats are refused and refunded once the payment reveals them — the identity cannot be known before money moves; a missing identity and weaker signals are flagged for the Officer (ADR-0010, ADR-0023).
7. **Only adults exist in the register.** No minor holds a record, a profile or a directory entry; minors appear only as a headcount on an Event Pass, and are excluded from presence tracking, analytics and targeted notification (ADR-0003, ADR-0005, ADR-0016).
8. **Adults are never entered by someone else.** Registration is self-service and invite-based; every link is confirmed by the receiving Family's Head (ADR-0005).
9. **The directory contains living Members only** (ADR-0001).
10. **Publication never archives a Member.** A Shok Sandesh announces; Archival requires family or Officer confirmation (ADR-0009).
11. **Explicit imagery is removed, and once automated screening exists it is refused at upload.** Until screening ships, an uploaded image is accepted unscreened and the Officer removes an explicit one after the fact; no photo is shown to anyone but its uploader before screening exists, so the directory hides photos until it does. Once screening exists, an image is refused rather than admitted when the check cannot be completed. Culturally ordinary imagery is not treated as explicit (ADR-0006, ADR-0022).
12. **Commercial Notices publish only after their Posting Fee completes,** and are refunded only on technical publication failure (ADR-0004, amount per ADR-0008). A board with no Posting Fee set does not open (ADR-0016).
13. **A Notice hidden by Reports counts Reports from distinct Families,** so one household cannot hide a Notice alone (ADR-0001).
14. **A suspension is visible to the suspended Member,** preserves their message history, and ends either by expiry or by Officer attestation (ADR-0005, ADR-0006).
15. **A Blood SOS always reports its Donor Reach to the requester,** and widens beyond blood-group matching rather than notifying almost nobody (ADR-0011, ADR-0025).
16. **A Member's phone number is visible to their linked Family, and beyond it only to a Friend the Member has chosen to show it to.** No setting publishes it: the wider Samaj never sees it, and it is never exposed through Contact Requests, Auto-Groups or Blood SOS. A Contact Share is off by default, reaches one Friend and is revocable (ADR-0001, ADR-0018, ADR-0021).
17. **Erasure purges member-visible data immediately** and holds statutory records in restricted storage for the retention period, after which they are deleted (ADR-0005).
18. **The Officer is a published, named human with a stated grievance response time.** Every automated refusal has an Officer path to reversal (ADR-0005). The response time is 30 days (ADR-0017). The Officer is appointed by the Operator and is currently a single person, Mr Rahul, who also owns the Operator (ADR-0012, ADR-0015, ADR-0016).
19. **An Event Pass admits one Member to one Event,** is non-transferable, is invalid once that Event ends, and verifies at the gate without network. Accompanying minors are a headcount on the Head of Family's pass, never individually scanned passes, because minors are excluded from presence tracking (ADR-0013, ADR-0024, invariant 7).
20. **Blood Group is never displayed to anyone.** It is collected from every Member and used only to match a Blood SOS to consenting donors — not shown in the directory, not shown to linked family, not shown to the wider Samaj (ADR-0016).
21. **A Member's name is held in every script the Member supplied,** at least one and both when they gave both. Neither script is ever machine-generated as their name: Hindi entry yields a Latin string offered for confirmation, English entry leaves the Devanagari field empty, and a name displays in the script the Member supplied even inside the other language's UI. A derived Latin string may exist only as a search key (ADR-0016, ADR-0019).
22. **Every register field has exactly one audience, and an unnamed field is Member-only.** The wider Samaj and linked Family both see name, Gotra, city, state, photo and Business Listing; linked Family additionally sees the phone number and the father's/husband's name; a Friend additionally sees the phone number and email only where a Contact Share grants them; email is otherwise seen by the Member alone; Address 1, Address 2, ZIP/Pincode, date of birth and Nominee are seen by the Member alone; Blood Group by nobody. Visibility is closed by default, so a field with no stated audience — Native Place, Kuldevi/Kuldevta, anything added later — is Member-only until a decision opens it (ADR-0017, ADR-0018, ADR-0019, ADR-0020, ADR-0021).
23. **An Event Pass never carries a charge** (ADR-0017).
24. **A Nominee is read by the Member alone, and by the Officer only on a confirmed death or Archival request, logged.** The named Nominee is not notified of the nomination (ADR-0018).
25. **A phone number belongs to at most one Member.** It is how that Member signs in, so a shared number would open one Member's private fields to everyone holding the phone. An adult without a number of their own cannot register — a known exclusion, accepted (ADR-0023).

---

## Open questions

These decisions are still open and are deliberately not settled here:

- **The Officer's grievance email address.** **Resolved 21 September 2026 (ADR-0027):** the mailbox is `help.agrawal.app@gmail.com`, handed over by the Operator and under their control. The channel remains email only, with the 30-day response time (ADR-0017, ADR-0026 §2), and the data fiduciary is named: the Operator is Mr Rahul Kumar Agrawal, the proprietor personally, with no separate registered company name (ADR-0026 §1). The consent and privacy notices can now publish the channel.
- **Friends: delivery stage and email collection.** Friends and Contact Share are prototyped in the directory (ADR-0021), but not yet placed in Stage 2 or Stage 3, and the registration form does not collect the optional email yet. Blocking and reporting Friend Requests must exist before launch.

Nothing else is open. The community's name in Latin script is settled as **"Agrawal"** by the production-domain decision `agrawal.app` (ADR-0026 §4): the Stage 1 brief's "Agarwal" mandate is superseded, and the Devanagari form `अग्रवाल` is unaffected (invariant 21). Every other decision on the design tree is settled in `feature-list.md`, the invariants above, or `docs/adr/`. What remains outstanding is the one Operator fact still owed — the Google Cloud project for romanization — plus the Friends question above. The grievance mailbox was handed over on 21 September 2026 (`help.agrawal.app@gmail.com`, ADR-0027). The logo has been supplied, as a raster lockup; a vector original is still wanted for production.
