-- CreateTable
CREATE TABLE "otp_challenge" (
    "id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "otp_challenge_phone_e164_idx" ON "otp_challenge"("phone_e164");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agrawal_app'
  ) THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "otp_challenge" TO agrawal_app';
  END IF;
END;
$$;
