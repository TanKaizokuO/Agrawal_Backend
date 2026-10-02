# Module: Media

Owns uploaded images: storage in S3, visibility, Officer removal, and (from M12) automated screening. Stage 1 without screening; screening before 11 October.

Read `CONTEXT.md` invariant 11 (as rewritten on 18 September) and the Officer entry first.

**Implementation status (2 October 2026):** the 30-live-images per-owner quota and `MEDIA_QUOTA_EXCEEDED` response below are approved ADR-0026 requirements, not implemented enforcement. The current service does not count live owner images before upload. Quota enforcement and boundary tests remain open source work in `docs/REMAINING BACKEND WORK.md`.

## The rule this module exists to keep

Until screening ships, an image is accepted **unscreened**, is visible to **its uploader only**, and the Officer removes an explicit one after the fact. Once `IMAGE_SCREENING_ENABLED=true`, every new image is screened at upload and refused if explicit **or if the check cannot complete** (fail-closed), and only `APPROVED` images are visible to anyone other than the uploader. Culturally ordinary imagery is not treated as explicit (ADR-0006).

## Models

```prisma
model Image {
  id                 String        @id          // uuid v7; also the S3 key stem
  purpose            ImagePurpose
  status             ImageStatus   @default(UNSCREENED)
  ownerRegistrationId String?                    // while an Applicant owns it
  ownerMemberId      String?                     // once a Member owns it
  familyId           String?                     // FAMILY_PHOTO only
  s3Key              String                      // images/<id>.jpg
  widthPx            Int
  heightPx           Int
  bytes              Int
  screeningScore     Json?                       // raw Sightengine classes kept for the Officer
  statusReason       String?                     // EXPLICIT | SCREENING_UNAVAILABLE | OFFICER:<reason>
  createdAt          DateTime      @default(now())
  screenedAt         DateTime?
  removedAt          DateTime?
  removedBy          String?                     // Officer memberId
  @@index([status, createdAt])
  @@index([ownerMemberId])
  @@index([ownerRegistrationId])
}

enum ImagePurpose { MEMBER_PHOTO FAMILY_PHOTO BUSINESS_PHOTO SHOK_SANDESH_PHOTO }
enum ImageStatus  { UNSCREENED APPROVED REJECTED REMOVED }
```

## Upload

`POST /v1/media/images` — `multipart/form-data`, fields `purpose` and `file`. Auth: principal (an Applicant may upload `MEMBER_PHOTO` and `FAMILY_PHOTO`; Stage 2 purposes need a Member). Rate limit `media.upload`.

1. `multer` memory storage, limit 8 MB, one file. Reject anything whose magic bytes are not JPEG, PNG, WebP or HEIC (`file-type` package) → `415 IMAGE_TYPE_UNSUPPORTED`. Then the per-owner quota (ADR-0026 §11): the owner — an Applicant's registration or a Member — may hold at most 30 live images (`status` UNSCREENED or APPROVED; REMOVED and REJECTED do not count). A further upload → `422 MEDIA_QUOTA_EXCEEDED`, checked before any re-encoding.
2. `sharp(buffer).rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true })` — this strips EXIF (including GPS) because metadata is not copied unless requested. Never store the original.
3. Screening:
   - `IMAGE_SCREENING_ENABLED=false` → status `UNSCREENED`.
   - `true` → call the `ImageScreener` port with the re-encoded bytes (timeout 8 s, one retry). Rejected when `max(nudity.sexual_activity, nudity.sexual_display, nudity.erotica) ≥ 0.85` (ADR-0006; suggestive classes ignored). Timeout, error or non-200 → `REJECTED` with `SCREENING_UNAVAILABLE`. A rejected image is not written to S3.
4. `PutObject` to the private bucket at `images/<id>.jpg`, `ContentType: image/jpeg`, server-side encryption `AES256`.
5. Response `201`: `{ imageId, status, previewUrl }` (`previewUrl` presigned for the uploader). On `REJECTED`: `422 IMAGE_REFUSED` with `details.reason` and the Officer-review hint.

Sightengine call: `POST https://api.sightengine.com/1.0/check.json` as multipart with `media` (the bytes), `models=nudity-2.1`, `api_user`, `api_secret`. Parse with zod; unexpected shape counts as unavailable.

## Visibility

- `media.urlFor(imageId, viewerMemberId | registrationId)`: returns a presigned GET URL (`MEDIA_URL_TTL_SECONDS`) when the viewer may see it, else `null`.
  - The uploader (owner registration or owner member) may see their own image in any status except `REMOVED`.
  - Anyone else: only when `status = APPROVED`. With screening off, nothing is `APPROVED`, so others see no photos.
  - Whether a Member's photo is shown at all (consent, relation) is Register's decision; Media only answers "is this image showable to others".
- `media.isVisibleToOthers(imageId)` → `status === "APPROVED"`.

## Officer review and removal

- `GET /v1/officer/images?status=UNSCREENED|APPROVED|REJECTED&cursor=` (role OFFICER): newest first, each with a presigned URL, purpose and owner Member ID. Every page viewed writes a Processing Record `OFFICER_IMAGES_VIEWED` with the image IDs.
- `POST /v1/officer/images/:imageId/remove` `{ reason: string (5..300) }`: Media marks the image `REMOVED`, then emits `onImageRemoved` in the same transaction. Register and Noticeboards detach their own Member/Family/Notice references; Media does not write those tables. `src/main.ts` registers each owner's handler for its image purposes. Handlers run sequentially and are awaited: a handler failure aborts the transaction, prevents later removal work and skips S3 deletion enqueue. On success, `register.postOfficerMessage(IMAGE_REMOVED, reason)` tells the owner, a Processing Record `IMAGE_REMOVED` is written, and S3 deletion is enqueued. The Member is never removed for an image (`CONTEXT.md`, Officer).
- `POST /v1/officer/images/:imageId/approve` (Stage 2, screening on): an Officer override of a wrong refusal (invariant 18) → `APPROVED`, Processing Record `IMAGE_OVERRIDE_APPROVED`. Only possible while the S3 object exists, so from M12 a `REJECTED` image **is** stored, in a `quarantine/` prefix, for 30 days, then deleted by a job. (Amend step 3 accordingly when M12 lands.)

## Backlog screening (M12)

When screening is switched on, `media.screenBacklog` runs every `UNSCREENED` image through the screener, oldest first, 2 per second. Explicit → `REJECTED` and emits `onImageRemoved` so the owner module detaches its reference; the owner is told by an Officer message. Unavailable → stays `UNSCREENED` and is retried next run. Until the backlog is empty, those images stay uploader-only.

## Ownership transfer and cleanup

- `media.reassign(tx, imageIds, { fromRegistrationId, ownerMemberId, familyId? })` at Registration completion. Every id must be owned by `fromRegistrationId`, otherwise nothing moves and it throws `IMAGE_NOT_OWNED`.
- `media.deleteOwnedByRegistration(tx, registrationId)` when a Registration ends without completing.
- `media.deleteAllForMember(tx, memberId)` on Erasure (Register hook).
- Images never attached to anything within 24 hours of upload are deleted by `media.gcOrphans` (daily).
- S3 deletion always runs in a job after the transaction commits (`media.deleteObject`), so a rollback never deletes a live object.

## Public interface (`index.ts`)

```ts
urlFor(imageId: string, viewer: Viewer): Promise<string | null>
isVisibleToOthers(imageId: string): Promise<boolean>
ownedBy(imageId: string, owner: Owner, purpose: ImagePurpose): Promise<boolean>
reassign(tx, imageIds: string[], { fromRegistrationId, ownerMemberId, familyId? }): Promise<void>
deleteOwnedByRegistration(tx, registrationId: string): Promise<void>
deleteAllForMember(tx, memberId: string): Promise<void>
onImageRemoved(handler): void   // attached-image removals emit; owners detach matching references in the same transaction; handler failures propagate
```

## Required tests

- invariant 11 (screening off): an Applicant's uploaded photo has a URL for the Applicant and `null` for any other Member, before and after the Member completes registration.
- invariant 11 (screening on): screener returns 0.9 erotica → `IMAGE_REFUSED`; screener times out → `IMAGE_REFUSED` with `SCREENING_UNAVAILABLE`; 0.6 suggestive only → approved.
- EXIF GPS present in the upload is absent from the stored object.
- A text file renamed `.jpg` → 415.
- Officer removal → status `REMOVED`, the matching Member/Family/Notice image reference cleared by its owner module, an `OfficerMessage` exists, a Processing Record exists, the S3 object deletion job ran after commit.
- A non-Officer calling the Officer routes → 403.
- Quota: the 31st live image → `422 MEDIA_QUOTA_EXCEEDED`; REMOVED and REJECTED images do not count toward the 30 (ADR-0026 §11).

Module error codes: `IMAGE_TYPE_UNSUPPORTED` 415, `IMAGE_TOO_LARGE` 413, `IMAGE_REFUSED` 422, `IMAGE_NOT_FOUND` 404, `IMAGE_NOT_OWNED` 422, `MEDIA_QUOTA_EXCEEDED` 422.
