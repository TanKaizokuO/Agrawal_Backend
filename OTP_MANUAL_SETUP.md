# OTP Login — Manual Setup Checklist

**For:** Kush
**Date:** 4 October 2026

## Background

OTP login has been rebuilt. The backend now generates the 6-digit code itself, stores it hashed, expires it after 5 minutes, and sends it by SMS through **Amazon SNS**. Both the mobile app and the web app use this flow. Firebase phone login and the fixed test code `123456` have been removed.

The code is finished and tested locally. What's left needs accounts, legal documents or production access, so it has to be done by hand. Decision records: ADR-0033 and ADR-0034 (`docs/adr/0034-sms-otp-delivery-via-amazon-sns.md` in the [Agrawal_App](https://github.com/TanKaizokuO/Agrawal_App) repo).

The production settings are declared in Terraform (`deploy/terraform/kms_ssm.tf` in this repo), and the EC2 role (`deploy/terraform/ec2.tf`) includes `sns:Publish` permission for the production host. You only need to fill in their values. Run `terraform validate` before `terraform apply`.

---

## 1. Indian SMS registration (DLT) — blocks real SMS

Indian carriers only deliver SMS from registered senders and templates. Register on **one** telecom DLT portal (Jio TrueConnect, Airtel, Vi or BSNL); they share registrations with each other.

- [ ] **Entity registration:** costs about ₹5,900 once, using the samaj's PAN and registration documents. You get an **entity ID (PEID)**.
- [ ] **Sender header:** 6 letters, transactional, for example `AGRSMJ`.
- [ ] **Content template:** category **Transactional**, with one variable for the code. For example:

  ```
  {#var#} is your OTP to log in to Agrawal Samaj. It is valid for 5 minutes. Do not share it with anyone. - AGRSMJ
  ```

  Keep "5 minutes": the backend expires codes after 300 seconds. You get a **DLT template ID**.

## 2. AWS End User Messaging SMS / Amazon SNS setup

- [ ] In the AWS End User Messaging SMS / Amazon SNS console for India (`ap-south-1`):
  - Register the **Sender ID** matching the DLT-approved 6-character header (`SNS_SMS_SENDER_ID`).
  - Register the **Entity ID (PEID)** (`SNS_SMS_ENTITY_ID`).
  - Register the **Template ID** (`SNS_SMS_TEMPLATE_ID`).
- [ ] Request production access to exit the AWS SMS sandbox and raise the monthly SMS spend limit via AWS Support.
- [ ] Verify that the EC2 instance role (`deploy/terraform/ec2.tf`) has `sns:Publish` permission attached. (Parent is adding this policy to Terraform).
- [ ] Note: Live SNS delivery has not been verified yet on production.

## 3. Production secrets

The repo has two deploy paths. Set the values in **whichever one is actually used**:

- **`deploy.sh`** reads SSM parameters `/agrawal/production/*`. Run `terraform apply` to create the placeholder parameters, then overwrite them with `aws ssm put-parameter --overwrite` (use `--type SecureString` for the secret ones).
- **`deploy.yml`** reads Secrets Manager `prod/agrawal/env`. Add the same keys there.

| Key | Value |
|---|---|
| `SMS_PROVIDER` | `sns` |
| `SNS_SMS_SENDER_ID` | DLT-approved 6-character sender ID header (e.g. `AGRSMJ`) |
| `SNS_SMS_ENTITY_ID` | DLT Principal Entity ID (PEID) |
| `SNS_SMS_TEMPLATE_ID` | DLT Content Template ID |
| `SNS_SMS_OTP_MESSAGE` | Exact DLT-approved text with `{otp}` placeholder (e.g. `{#var#}` in DLT becomes `{otp}`: `{otp} is your OTP to log in to Agrawal Samaj. It is valid for 5 minutes. Do not share it with anyone. - AGRSMJ`) |
| `OTP_HMAC_KEY` | output of `openssl rand -base64 32` (**SecureString**; generate once and never change it, or every unused code becomes invalid) |

> If any key is missing or still says `PLACEHOLDER_SET_BY_OPERATOR`, the backend refuses to start. That's intentional.

## 4. Deploy, in this order

1. [ ] **Backend.** `deploy.sh` runs `prisma migrate deploy` before restarting, which creates the new `OtpChallenge` table. If you deploy through `deploy.yml`, it hasn't been checked whether that runs migrations; make sure the table exists first.
2. [ ] **Smoke test:** request an OTP for your own phone, then log in on web and on mobile.
3. [ ] **Web:** redeploy, and remove the old `VITE_FIREBASE_*` variables from the hosting settings.
4. [ ] **Mobile:** build and release new app versions.

> ⚠️ **Older installed app versions can't log in once the new backend is live**, because they use the removed `123456` flow. Release the app update at the same time, or force an update.

## 5. Decisions still open

- [ ] **App store review:** there's no fixed review code any more. Apple and Google reviewers need a way to log in; decide how to give them one.
- [ ] **Firebase console:** once rollout is done, the Phone sign-in provider can be turned off. **Keep the Firebase project**, because push notifications still use it.

## 6. Git

Nothing is committed yet. The changes are in three repos, mainly `Agrawal_Backend`, `Agrawal_App` and `Agrawal_Frontend`. A few top-level files changed too, for example `CONNECTION_PLAN.md` and `DUMMAY_ACCOUNT.md`. These need to be committed and pushed before deploying.
