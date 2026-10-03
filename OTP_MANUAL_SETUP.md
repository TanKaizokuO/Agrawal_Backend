# OTP Login — Manual Setup Checklist

**For:** Kush
**Date:** 3 October 2026

## Background

OTP login has been rebuilt. The backend now generates the 6-digit code itself, stores it hashed, expires it after 5 minutes, and sends it by SMS through **MSG91**. Both the mobile app and the web app use this flow. Firebase phone login and the fixed test code `123456` have been removed.

The code is finished and tested locally. What's left needs accounts, legal documents or production access, so it has to be done by hand. Decision record: ADR-0033, `docs/adr/0033-backend-sms-otp-and-msg91.md` in the [Agrawal_App](https://github.com/TanKaizokuO/Agrawal_App) repo.

The five new production settings are already declared in Terraform (`deploy/terraform/kms_ssm.tf:119-123` in this repo). You only need to fill in their values. That Terraform change hasn't been validated yet, so **run `terraform validate` before `terraform apply`**.

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

## 2. MSG91 account

- [ ] Sign up, complete KYC, and recharge (minimum ₹1,250 + GST).
- [ ] In MSG91's DLT settings, enter the **PEID**, **sender header** and **DLT template ID** from step 1.
- [ ] Create a **Flow** template with exactly the same text, using `##otp##` where the code goes. If you name the variable something other than `otp`, use that name for `MSG91_OTP_VAR` below.
- [ ] Copy the **auth key** and the **Flow template ID**.
- [ ] If you turn on MSG91's IP whitelisting, add the production server's IP.

## 3. Production secrets

The repo has two deploy paths. Set the values in **whichever one is actually used**:

- **`deploy.sh`** reads SSM parameters `/agrawal/production/*`. Run `terraform apply` to create the placeholder parameters, then overwrite them with `aws ssm put-parameter --overwrite` (use `--type SecureString` for the secret ones).
- **`deploy.yml`** reads Secrets Manager `prod/agrawal/env`. Add the same five keys there.

| Key | Value |
|---|---|
| `SMS_PROVIDER` | `msg91` |
| `MSG91_AUTH_KEY` | MSG91 auth key (**SecureString**) |
| `MSG91_TEMPLATE_ID` | MSG91 Flow template ID |
| `MSG91_OTP_VAR` | `otp` |
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
