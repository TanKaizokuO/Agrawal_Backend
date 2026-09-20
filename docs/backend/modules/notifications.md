# Module: Notifications

Owns device tokens and push delivery through Firebase Cloud Messaging to the Flutter app. Stage 2. There is no Web Push, SMS or WhatsApp in Stage 1–2: a Member without the app installed receives no pushes, and every feature that pushes must still work (and tell the truth about reach) without them.

## Models

```prisma
model DeviceToken {
  token       String   @id
  memberId    String
  platform    String            // ANDROID | IOS
  appVersion  String?
  createdAt   DateTime @default(now())
  lastSeenAt  DateTime @default(now())
  @@index([memberId])
}

model PushDelivery {
  id          String   @id
  memberId    String
  topic       String            // BLOOD_SOS_ALERT | JOIN_REQUEST | JOIN_OUTCOME | ARCHIVAL_REQUEST | NOTICE_HIDDEN | SUSPENSION | OFFICER_MESSAGE | EVENT
  subjectId   String            // e.g. the Blood SOS alert id
  acceptedCount Int             // tokens FCM accepted
  failedCount   Int
  createdAt   DateTime @default(now())
  @@index([topic, subjectId])
}
```

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| PUT | `/v1/me/devices/:token` | member | `{ platform, appVersion? }` — upsert; if the token belonged to another Member, move it (a shared phone changed hands). |
| DELETE | `/v1/me/devices/:token` | member | On sign-out in the app. |

Signing out (`DELETE /v1/auth/session`) from a mobile session also deletes that device's token when the app sends it in `X-Device-Token`.

## Sending

`notifications.send(memberIds, message)` where `message = { topic, subjectId, title: {en, hi}, body: {en, hi}, data: Record<string,string> }`:

1. Load tokens for the Members. Choose the title/body language from each Member's `uiLanguage`.
2. `messaging().sendEach(...)` in batches of 500 with `android.priority: "high"` and, for `BLOOD_SOS_ALERT`, `apns.headers["apns-priority"] = "10"`.
3. Per token: success → accepted; error `messaging/registration-token-not-registered` or `messaging/invalid-registration-token` → delete the token; other errors → failed (retry the whole send once after 30 s for failed tokens only).
4. Insert one `PushDelivery` per Member with `acceptedCount`/`failedCount`.
5. Return per-Member `{ accepted: boolean }` — **accepted means FCM accepted the message for at least one of the Member's devices.** It says nothing about the person having seen it. Blood SOS's Donor Reach is built on exactly this (`CONTEXT.md`, Donor Reach).

Push payloads carry IDs and display text only — never phone numbers, blood group, address or anything outside the recipient's own projection of the subject.

Minors never receive targeted notifications (invariant 7); there are no minor records, so this holds structurally.

## Who gets pushed what (Stage 2)

| Topic | Recipient | Trigger |
|---|---|---|
| `JOIN_REQUEST` | Head of the Family | A joining Registration reaches `AWAITING_HEAD` |
| `JOIN_OUTCOME` | — | Not pushable: the joiner is an Applicant with no app session and no token. They see the outcome on their next sign-in. |
| `NOMINEE_PROMPT` | Members whose `nomineePromptPending` became true | `onFamilyGainedMember` |
| `ARCHIVAL_REQUEST` | Adult Members of the deceased's Family | Archival Request opened |
| `BLOOD_SOS_ALERT` | Matched Donors | Each widening step |
| `BLOOD_SOS_RESPONSE` | The requester | A Donor accepts |
| `NOTICE_HIDDEN` / `SUSPENSION` | The author | Report threshold reached (invariant 14: never silent) |
| `OFFICER_MESSAGE` | The Member | Officer removes an image, lifts a suspension |
| `EVENT` | — | No event broadcasts in Stage 2 (WhatsApp mass notification is Stage 3). |

## Public interface (`index.ts`)

```ts
send(memberIds: string[], message: PushMessage): Promise<Map<string, { accepted: boolean }>>
deleteTokensForMember(tx, memberId: string): Promise<void>
```

## Required tests

- A token FCM reports as unregistered is deleted and the Member counts as not accepted.
- A Member with two devices, one accepted → accepted.
- A Member with no tokens → not accepted, a `PushDelivery` row with zeros.
- Payload language follows `uiLanguage`.
- Token re-registered by a different Member moves to them.
