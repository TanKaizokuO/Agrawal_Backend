-- Extensions required by the API.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SosStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "SosPlaceSource" AS ENUM ('PINCODE', 'REQUESTER');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('UPCOMING', 'ONGOING', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PassStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "session_client" AS ENUM ('WEB', 'MOBILE');

-- CreateEnum
CREATE TYPE "role" AS ENUM ('OFFICER', 'OPERATOR', 'ORGANISER');

-- CreateEnum
CREATE TYPE "ImagePurpose" AS ENUM ('MEMBER_PHOTO', 'FAMILY_PHOTO', 'BUSINESS_PHOTO', 'SHOK_SANDESH_PHOTO');

-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('UNSCREENED', 'APPROVED', 'REJECTED', 'REMOVED');

-- CreateEnum
CREATE TYPE "NoticeBoard" AS ENUM ('SHOK_SANDESH', 'BUSINESS_LISTING');

-- CreateEnum
CREATE TYPE "NoticeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'HIDDEN', 'EXPIRED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ArchivalRequestStatus" AS ENUM ('OPEN', 'CONFIRMED', 'REFUTED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "FlagKind" AS ENUM ('NO_PAYMENT_IDENTITY', 'POSSIBLE_DUPLICATE_PERSON', 'SHARED_ADDRESS', 'JOINER_PAYS_FROM_OTHER_HEAD');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('REGISTRATION', 'BUSINESS_LISTING');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'CAPTURED', 'FAILED', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "IdentityKind" AS ENUM ('VPA', 'CARD', 'NONE');

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('DUPLICATE_HEAD', 'JOIN_DECLINED', 'JOIN_EXPIRED', 'REGISTRATION_CANCELLED', 'REGISTRATION_ABANDONED', 'PUBLICATION_FAILED', 'OFFICER');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "FamilyStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('FEMALE', 'MALE', 'OTHER');

-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG');

-- CreateEnum
CREATE TYPE "NativePlaceKind" AS ENUM ('LISTED', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Gotra" AS ENUM ('GARG', 'GOYAL', 'GOYAN', 'BANSAL', 'KANSAL', 'SINGHAL', 'JINDAL', 'TINGAL', 'MOHAN', 'DHARAN', 'MADHUKUL', 'BINDAL', 'MITTAL', 'TAYAL', 'MANGAL', 'AIRAN', 'NANGAL', 'KUCHHAL');

-- CreateEnum
CREATE TYPE "IndianState" AS ENUM ('ANDHRA_PRADESH', 'ARUNACHAL_PRADESH', 'ASSAM', 'BIHAR', 'CHHATTISGARH', 'GOA', 'GUJARAT', 'HARYANA', 'HIMACHAL_PRADESH', 'JHARKHAND', 'KARNATAKA', 'KERALA', 'MADHYA_PRADESH', 'MAHARASHTRA', 'MANIPUR', 'MEGHALAYA', 'MIZORAM', 'NAGALAND', 'ODISHA', 'PUNJAB', 'RAJASTHAN', 'SIKKIM', 'TAMIL_NADU', 'TELANGANA', 'TRIPURA', 'UTTAR_PRADESH', 'UTTARAKHAND', 'WEST_BENGAL', 'ANDAMAN_AND_NICOBAR_ISLANDS', 'CHANDIGARH', 'DADRA_AND_NAGAR_HAVELI_AND_DAMAN_AND_DIU', 'DELHI', 'JAMMU_AND_KASHMIR', 'LADAKH', 'LAKSHADWEEP', 'PUDUCHERRY');

-- CreateEnum
CREATE TYPE "LinkKind" AS ENUM ('BIRTH');

-- CreateEnum
CREATE TYPE "ConsentToggle" AS ENUM ('DIRECTORY', 'BLOOD_GROUP', 'PHOTO', 'PAYMENT_DISCLOSURE_ACK');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('STARTED', 'PAID', 'AWAITING_HEAD', 'COMPLETED', 'ABANDONED', 'CANCELLED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RegistrationRoute" AS ENUM ('INDIVIDUAL', 'CREATE', 'JOIN');

-- CreateEnum
CREATE TYPE "RegistrationFoundingKind" AS ENUM ('INDIVIDUAL', 'CREATE');

-- CreateTable
CREATE TABLE "rate_limit_bucket" (
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_bucket_pkey" PRIMARY KEY ("name","key","window_start")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL,
    "principal_key" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blood_sos_request" (
    "id" TEXT NOT NULL,
    "requester_member_id" TEXT NOT NULL,
    "status" "SosStatus" NOT NULL DEFAULT 'ACTIVE',
    "blood_group" "BloodGroup" NOT NULL,
    "hospital_name" TEXT NOT NULL,
    "hospital_pincode" TEXT NOT NULL,
    "hospital_city" TEXT NOT NULL,
    "hospital_city_key" TEXT NOT NULL,
    "hospital_district" TEXT,
    "hospital_state" TEXT NOT NULL,
    "place_source" "SosPlaceSource" NOT NULL,
    "patient_name" TEXT,
    "units_needed" INTEGER,
    "note" TEXT,
    "current_tier" INTEGER NOT NULL DEFAULT 1,
    "donor_reach_total" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "fulfilled_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "closed_by" TEXT,
    "closed_reason" TEXT,

    CONSTRAINT "blood_sos_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blood_sos_alert" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "donor_member_id" TEXT NOT NULL,
    "blood_group_match" BOOLEAN NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blood_sos_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blood_sos_response" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "donor_member_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blood_sos_response_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donor_preference" (
    "member_id" TEXT NOT NULL,
    "snoozed_at" TIMESTAMPTZ(6),
    "snooze_until" TIMESTAMPTZ(6),
    "last_donated_on" DATE,

    CONSTRAINT "donor_preference_pkey" PRIMARY KEY ("member_id")
);

-- CreateTable
CREATE TABLE "donor_alert_day" (
    "member_id" TEXT NOT NULL,
    "day_ist" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "donor_alert_day_pkey" PRIMARY KEY ("member_id","day_ist")
);

-- CreateTable
CREATE TABLE "event" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "title_hi" TEXT,
    "description" TEXT,
    "description_hi" TEXT,
    "venue" TEXT NOT NULL,
    "venue_city" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" TEXT NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'UPCOMING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_pass" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "is_head" BOOLEAN NOT NULL,
    "minors_count" INTEGER NOT NULL DEFAULT 0,
    "status" "PassStatus" NOT NULL DEFAULT 'ACTIVE',
    "qr_payload" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,

    CONSTRAINT "event_pass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission" (
    "id" TEXT NOT NULL,
    "pass_id" TEXT NOT NULL,
    "gate_device_id" TEXT NOT NULL,
    "scanned_at" TIMESTAMPTZ(6) NOT NULL,
    "scanned_offline" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "admission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_device" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "registered_by" TEXT NOT NULL,
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "client" "session_client" NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "member_id" UUID,
    "registration_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_role" (
    "member_id" UUID NOT NULL,
    "role" "role" NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_role_pkey" PRIMARY KEY ("member_id","role")
);

-- CreateTable
CREATE TABLE "image" (
    "id" UUID NOT NULL,
    "purpose" "ImagePurpose" NOT NULL,
    "status" "ImageStatus" NOT NULL DEFAULT 'UNSCREENED',
    "owner_registration_id" UUID,
    "owner_member_id" UUID,
    "family_id" UUID,
    "s3_key" TEXT NOT NULL,
    "width_px" INTEGER NOT NULL,
    "height_px" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "screening_score" JSONB,
    "status_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "screened_at" TIMESTAMPTZ(6),
    "removed_at" TIMESTAMPTZ(6),
    "removed_by" UUID,

    CONSTRAINT "image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice" (
    "id" TEXT NOT NULL,
    "board" "NoticeBoard" NOT NULL,
    "author_member_id" TEXT NOT NULL,
    "author_family_id" TEXT NOT NULL,
    "status" "NoticeStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT,
    "body_hi" TEXT,
    "body_en" TEXT,
    "linked_member_id" TEXT,
    "image_id" TEXT,
    "metadata" JSONB,
    "payment_id" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "hidden_at" TIMESTAMPTZ(6),
    "hidden_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_listing_meta" (
    "notice_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "business_city" TEXT NOT NULL,
    "business_city_key" TEXT NOT NULL,
    "business_phone" TEXT NOT NULL,
    "business_address" TEXT,

    CONSTRAINT "business_listing_meta_pkey" PRIMARY KEY ("notice_id")
);

-- CreateTable
CREATE TABLE "archival_request" (
    "id" TEXT NOT NULL,
    "notice_member_id" TEXT,
    "deceased_member_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "status" "ArchivalRequestStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(6),
    "responded_by" TEXT,
    "escalated_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "archival_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "notice_id" TEXT,
    "reporter_member_id" TEXT NOT NULL,
    "reporter_family_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suspension" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "active_notice_id" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "lifted_at" TIMESTAMPTZ(6),
    "lifted_by" TEXT,
    "lifted_reason" TEXT,

    CONSTRAINT "suspension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_token" (
    "token" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "app_version" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_token_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "push_delivery" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "retry_scheduled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_delivery_token" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_delivery_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_record" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "retain_until" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "processing_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flag" (
    "id" TEXT NOT NULL,
    "kind" "FlagKind" NOT NULL,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "related_ids" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" TEXT,
    "resolution" TEXT,
    "note" TEXT,

    CONSTRAINT "flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "payer_phone_e164" TEXT NOT NULL,
    "payer_member_id" TEXT,
    "amount_paise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "razorpay_order_id" TEXT NOT NULL,
    "razorpay_payment_id" TEXT,
    "method" TEXT,
    "identity_kind" "IdentityKind",
    "identity_hash" TEXT,
    "identity_masked" TEXT,
    "captured_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "retain_until" TIMESTAMPTZ(6),

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "reason" "RefundReason" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "razorpay_refund_id" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "head_anchor" (
    "identity_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "head_anchor_pkey" PRIMARY KEY ("identity_hash")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "event_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "payload" JSONB NOT NULL,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "family" (
    "id" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "gotra" "Gotra" NOT NULL,
    "pincode_snapshot" TEXT NOT NULL,
    "head_member_id" TEXT,
    "status" "FamilyStatus" NOT NULL DEFAULT 'ACTIVE',
    "photo_image_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "family_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "name_en" TEXT,
    "name_hi" TEXT,
    "name_en_search_key" TEXT,
    "father_name_en" TEXT,
    "father_name_hi" TEXT,
    "father_name_en_search_key" TEXT,
    "gender" "Gender" NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "blood_group" "BloodGroup" NOT NULL,
    "address_line_1" TEXT NOT NULL,
    "address_line_2" TEXT,
    "city" TEXT NOT NULL,
    "city_key" TEXT NOT NULL,
    "district" TEXT,
    "state" "IndianState" NOT NULL,
    "pincode" TEXT NOT NULL,
    "native_place_kind" "NativePlaceKind" NOT NULL,
    "native_place_id" TEXT,
    "native_place_text" TEXT,
    "kuldevi" TEXT,
    "kuldevta" TEXT,
    "photo_image_id" TEXT,
    "nominee_member_id" TEXT,
    "nominee_prompt_pending" BOOLEAN NOT NULL DEFAULT false,
    "consent_directory" BOOLEAN NOT NULL DEFAULT true,
    "consent_blood_group" BOOLEAN NOT NULL,
    "consent_photo" BOOLEAN NOT NULL,
    "payment_disclosure_ack_at" TIMESTAMPTZ(6) NOT NULL,
    "ui_language" TEXT NOT NULL DEFAULT 'en',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),
    "archived_by" TEXT,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_link" (
    "member_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "kind" "LinkKind" NOT NULL DEFAULT 'BIRTH',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_link_pkey" PRIMARY KEY ("member_id")
);

-- CreateTable
CREATE TABLE "consent_event" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "toggle" "ConsentToggle" NOT NULL,
    "value" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erasure_request" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMPTZ(6),
    "executed_by" TEXT,

    CONSTRAINT "erasure_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "officer_message" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),

    CONSTRAINT "officer_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite" (
    "code" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invite_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "pincode_cache" (
    "pincode" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pincode_cache_pkey" PRIMARY KEY ("pincode")
);

-- CreateTable
CREATE TABLE "registration" (
    "id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'STARTED',
    "route" "RegistrationRoute",
    "founding_kind" "RegistrationFoundingKind",
    "join_family_id" TEXT,
    "join_family_public_id" TEXT,
    "submitted_profile" JSONB,
    "payment_id" TEXT,
    "completed_member_id" UUID,
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "end_reason" TEXT,
    "decline_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_id_counter" (
    "pincode" TEXT NOT NULL,
    "next_seq" INTEGER NOT NULL,

    CONSTRAINT "family_id_counter_pkey" PRIMARY KEY ("pincode")
);

-- CreateTable
CREATE TABLE "romanization_cache" (
    "text_hash" TEXT NOT NULL,
    "latin" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "romanization_cache_pkey" PRIMARY KEY ("text_hash")
);

-- CreateIndex
CREATE INDEX "rate_limit_bucket_window_start_idx" ON "rate_limit_bucket"("window_start");

-- CreateIndex
CREATE INDEX "idempotency_record_created_at_idx" ON "idempotency_record"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_principal_key_key" ON "idempotency_record"("principal_key", "key");

-- CreateIndex
CREATE INDEX "blood_sos_request_requester_idx" ON "blood_sos_request"("requester_member_id");

-- CreateIndex
CREATE INDEX "blood_sos_request_status_expires_idx" ON "blood_sos_request"("status", "expires_at");

-- CreateIndex
CREATE INDEX "blood_sos_alert_donor_idx" ON "blood_sos_alert"("donor_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "blood_sos_alert_request_donor_key" ON "blood_sos_alert"("request_id", "donor_member_id");

-- CreateIndex
CREATE INDEX "blood_sos_response_donor_idx" ON "blood_sos_response"("donor_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "blood_sos_response_request_donor_key" ON "blood_sos_response"("request_id", "donor_member_id");

-- CreateIndex
CREATE INDEX "donor_preference_snooze_until_idx" ON "donor_preference"("snooze_until");

-- CreateIndex
CREATE INDEX "event_status_starts_at_idx" ON "event"("status", "starts_at");

-- CreateIndex
CREATE INDEX "event_pass_member_id_idx" ON "event_pass"("member_id");

-- CreateIndex
CREATE INDEX "event_pass_event_status_idx" ON "event_pass"("event_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "event_pass_event_member_key" ON "event_pass"("event_id", "member_id");

-- CreateIndex
CREATE INDEX "admission_pass_id_idx" ON "admission"("pass_id");

-- CreateIndex
CREATE INDEX "admission_gate_scanned_at_idx" ON "admission"("gate_device_id", "scanned_at");

-- CreateIndex
CREATE UNIQUE INDEX "admission_pass_gate_scanned_key" ON "admission"("pass_id", "gate_device_id", "scanned_at");

-- CreateIndex
CREATE INDEX "gate_device_event_id_idx" ON "gate_device"("event_id");

-- CreateIndex
CREATE INDEX "gate_device_registered_by_event_idx" ON "gate_device"("registered_by", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_member_id_idx" ON "session"("member_id");

-- CreateIndex
CREATE INDEX "session_phone_e164_idx" ON "session"("phone_e164");

-- CreateIndex
CREATE INDEX "session_registration_id_idx" ON "session"("registration_id");

-- CreateIndex
CREATE INDEX "image_status_created_at_idx" ON "image"("status", "created_at");

-- CreateIndex
CREATE INDEX "image_owner_member_id_idx" ON "image"("owner_member_id");

-- CreateIndex
CREATE INDEX "image_owner_registration_id_idx" ON "image"("owner_registration_id");

-- CreateIndex
CREATE INDEX "notice_board_status_published_idx" ON "notice"("board", "status", "published_at");

-- CreateIndex
CREATE INDEX "notice_author_member_idx" ON "notice"("author_member_id");

-- CreateIndex
CREATE INDEX "notice_author_family_idx" ON "notice"("author_family_id");

-- CreateIndex
CREATE INDEX "notice_linked_member_idx" ON "notice"("linked_member_id");

-- CreateIndex
CREATE INDEX "business_listing_meta_category_city_idx" ON "business_listing_meta"("category", "business_city_key");

-- CreateIndex
CREATE INDEX "archival_request_deceased_member_idx" ON "archival_request"("deceased_member_id");

-- CreateIndex
CREATE INDEX "archival_request_status_expires_idx" ON "archival_request"("status", "expires_at");

-- CreateIndex
CREATE INDEX "report_target_family_idx" ON "report"("target_id", "reporter_family_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_target_reporter_key" ON "report"("target_id", "reporter_member_id");

-- CreateIndex
CREATE INDEX "suspension_member_ends_idx" ON "suspension"("member_id", "ends_at");

-- CreateIndex
CREATE INDEX "device_token_member_id_idx" ON "device_token"("member_id");

-- CreateIndex
CREATE INDEX "device_token_member_environment_idx" ON "device_token"("member_id", "environment");

-- CreateIndex
CREATE INDEX "push_delivery_topic_subject_idx" ON "push_delivery"("topic", "subject_id");

-- CreateIndex
CREATE INDEX "push_delivery_retry_idx" ON "push_delivery"("status", "retry_scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_delivery_member_topic_subject_key" ON "push_delivery"("member_id", "topic", "subject_id");

-- CreateIndex
CREATE INDEX "push_delivery_token_token_idx" ON "push_delivery_token"("token");

-- CreateIndex
CREATE UNIQUE INDEX "push_delivery_token_delivery_token_key" ON "push_delivery_token"("delivery_id", "token");

-- CreateIndex
CREATE INDEX "processing_record_subject_idx" ON "processing_record"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "processing_record_actor_at_idx" ON "processing_record"("actor_id", "at");

-- CreateIndex
CREATE INDEX "processing_record_retain_idx" ON "processing_record"("retain_until");

-- CreateIndex
CREATE INDEX "flag_status_created_idx" ON "flag"("status", "created_at");

-- CreateIndex
CREATE INDEX "flag_subject_idx" ON "flag"("subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_razorpay_order_id_key" ON "payment"("razorpay_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_razorpay_payment_id_key" ON "payment"("razorpay_payment_id");

-- CreateIndex
CREATE INDEX "payment_subject_id_idx" ON "payment"("subject_id");

-- CreateIndex
CREATE INDEX "payment_identity_hash_idx" ON "payment"("identity_hash");

-- CreateIndex
CREATE INDEX "payment_status_created_at_idx" ON "payment"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refund_razorpay_refund_id_key" ON "refund"("razorpay_refund_id");

-- CreateIndex
CREATE INDEX "refund_status_requested_at_idx" ON "refund"("status", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "refund_payment_id_unique" ON "refund"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "head_anchor_family_id_key" ON "head_anchor"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "family_public_id_key" ON "family"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "family_head_member_id_key" ON "family"("head_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_phone_e164_key" ON "member"("phone_e164");

-- CreateIndex
CREATE INDEX "member_status_city_key_idx" ON "member"("status", "city_key");

-- CreateIndex
CREATE INDEX "member_status_state_district_idx" ON "member"("status", "state", "district");

-- CreateIndex
CREATE INDEX "family_link_family_id_idx" ON "family_link"("family_id");

-- CreateIndex
CREATE INDEX "consent_event_member_id_idx" ON "consent_event"("member_id");

-- CreateIndex
CREATE INDEX "erasure_request_member_status_idx" ON "erasure_request"("member_id", "status");

-- CreateIndex
CREATE INDEX "officer_message_member_id_idx" ON "officer_message"("member_id");

-- CreateIndex
CREATE INDEX "invite_family_id_idx" ON "invite"("family_id");

-- CreateIndex
CREATE INDEX "invite_expires_at_idx" ON "invite"("expires_at");

-- CreateIndex
CREATE INDEX "registration_phone_status_idx" ON "registration"("phone_e164", "status");

-- CreateIndex
CREATE INDEX "registration_join_family_status_idx" ON "registration"("join_family_id", "status");

-- CreateIndex
CREATE INDEX "registration_status_activity_idx" ON "registration"("status", "last_activity_at");

-- AddForeignKey
ALTER TABLE "blood_sos_alert" ADD CONSTRAINT "blood_sos_alert_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "blood_sos_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blood_sos_response" ADD CONSTRAINT "blood_sos_response_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "blood_sos_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_pass" ADD CONSTRAINT "event_pass_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission" ADD CONSTRAINT "admission_pass_id_fkey" FOREIGN KEY ("pass_id") REFERENCES "event_pass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_device" ADD CONSTRAINT "gate_device_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_notice_id_fkey" FOREIGN KEY ("notice_id") REFERENCES "notice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_delivery_token" ADD CONSTRAINT "push_delivery_token_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "push_delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_link" ADD CONSTRAINT "family_link_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_link" ADD CONSTRAINT "family_link_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "family"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Register module — directory search, restricted erasure storage, and immutable identifiers.
CREATE INDEX IF NOT EXISTS member_name_en_trgm_idx
  ON member USING gin (name_en gin_trgm_ops);
CREATE INDEX IF NOT EXISTS member_name_hi_trgm_idx
  ON member USING gin (name_hi gin_trgm_ops);
CREATE INDEX IF NOT EXISTS member_name_en_search_key_trgm_idx
  ON member USING gin (name_en_search_key gin_trgm_ops);
CREATE INDEX IF NOT EXISTS member_city_key_trgm_idx
  ON member USING gin (city_key gin_trgm_ops);

CREATE SCHEMA IF NOT EXISTS restricted;

CREATE TABLE IF NOT EXISTS restricted.member_tombstone (
  member_id   TEXT        NOT NULL PRIMARY KEY,
  erased_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS restricted.payment (
  id                  TEXT        NOT NULL PRIMARY KEY,
  purpose             TEXT        NOT NULL,
  subject_id          TEXT        NOT NULL,
  payer_phone_e164    TEXT        NOT NULL,
  payer_member_id     TEXT,
  amount_paise        INT         NOT NULL,
  currency            TEXT        NOT NULL DEFAULT 'INR',
  status              TEXT        NOT NULL,
  razorpay_order_id   TEXT        NOT NULL,
  razorpay_payment_id TEXT,
  method              TEXT,
  identity_kind       TEXT,
  identity_hash       TEXT,
  identity_masked     TEXT,
  captured_at         TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  failure_reason      TEXT,
  consumed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until        TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS restricted.refund (
  id                TEXT        NOT NULL PRIMARY KEY,
  payment_id        TEXT        NOT NULL,
  reason            TEXT        NOT NULL,
  amount_paise      INT         NOT NULL,
  razorpay_refund_id TEXT,
  status            TEXT        NOT NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  failure_reason    TEXT,
  retain_until      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS restricted.consent_event (
  id          TEXT        NOT NULL PRIMARY KEY,
  member_id   TEXT        NOT NULL,
  toggle      TEXT        NOT NULL,
  value       BOOLEAN     NOT NULL,
  source      TEXT        NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS restricted_payment_member_retain_idx
  ON restricted.payment (payer_member_id, retain_until);
CREATE INDEX IF NOT EXISTS restricted_refund_retain_idx
  ON restricted.refund (retain_until);
CREATE INDEX IF NOT EXISTS restricted_consent_member_retain_idx
  ON restricted.consent_event (member_id, retain_until);
CREATE INDEX IF NOT EXISTS restricted_tombstone_retain_idx
  ON restricted.member_tombstone (retain_until);

CREATE OR REPLACE FUNCTION register_reject_immutable_member_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164 THEN
    RAISE EXCEPTION 'member phone_e164 is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_immutable_phone ON member;
CREATE TRIGGER member_immutable_phone
BEFORE UPDATE OF phone_e164 ON member
FOR EACH ROW
EXECUTE FUNCTION register_reject_immutable_member_update();

CREATE OR REPLACE FUNCTION register_reject_immutable_family_identifiers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.public_id IS DISTINCT FROM OLD.public_id
    OR NEW.gotra IS DISTINCT FROM OLD.gotra
    OR NEW.pincode_snapshot IS DISTINCT FROM OLD.pincode_snapshot THEN
    RAISE EXCEPTION 'family public identifiers are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS family_immutable_identifiers ON family;
CREATE TRIGGER family_immutable_identifiers
BEFORE UPDATE OF public_id, gotra, pincode_snapshot ON family
FOR EACH ROW
EXECUTE FUNCTION register_reject_immutable_family_identifiers();
-- Registration module — live-record uniqueness and state-machine protection.
CREATE UNIQUE INDEX IF NOT EXISTS registration_one_live_per_phone
  ON registration (phone_e164)
  WHERE status IN ('STARTED', 'PAID', 'AWAITING_HEAD');

CREATE OR REPLACE FUNCTION registration_reject_invalid_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'STARTED' AND NEW.status IN ('PAID', 'ABANDONED'))
      OR (OLD.status = 'PAID' AND NEW.status IN ('AWAITING_HEAD', 'COMPLETED', 'ABANDONED'))
      OR (OLD.status = 'AWAITING_HEAD' AND NEW.status IN ('COMPLETED', 'CANCELLED', 'DECLINED', 'EXPIRED'))
    ) THEN
      RAISE EXCEPTION 'invalid registration status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status = 'AWAITING_HEAD' THEN
    IF NEW.route IS DISTINCT FROM 'JOIN'
      OR NEW.join_family_id IS NULL
      OR NEW.submitted_profile IS NULL
      OR NEW.submitted_at IS NULL
      OR NEW.expires_at IS NULL THEN
      RAISE EXCEPTION 'awaiting-head registration is incomplete'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'only awaiting-head registrations may have expires_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'COMPLETED' THEN
    IF NEW.completed_member_id IS NULL OR NEW.ended_at IS NULL OR NEW.submitted_profile IS NOT NULL THEN
      RAISE EXCEPTION 'completed registration is incomplete or still retains profile data'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status IN ('ABANDONED', 'CANCELLED', 'DECLINED', 'EXPIRED') THEN
    IF NEW.ended_at IS NULL OR NEW.submitted_profile IS NOT NULL THEN
      RAISE EXCEPTION 'ended registration is incomplete or still retains profile data'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.route = 'JOIN' AND NEW.join_family_id IS NULL
    AND NEW.status NOT IN ('STARTED', 'PAID') THEN
    RAISE EXCEPTION 'joining registration must retain its family'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS registration_state_invariants ON registration;
CREATE TRIGGER registration_state_invariants
BEFORE INSERT OR UPDATE OF status, route, join_family_id, submitted_profile,
  submitted_at, expires_at, ended_at, completed_member_id
ON registration
EXECUTE FUNCTION registration_reject_invalid_transition();
-- Notices module — archival, search, and active-suspension protections.
CREATE UNIQUE INDEX IF NOT EXISTS archival_request_one_open
  ON archival_request (deceased_member_id)
  WHERE status IN ('OPEN', 'ESCALATED');

CREATE INDEX IF NOT EXISTS notice_title_trgm_idx
  ON notice USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS suspension_active_idx
  ON suspension (member_id, ends_at)
  WHERE lifted_at IS NULL;
-- Officer module — append-only processing-record protection.
REVOKE UPDATE, DELETE ON TABLE processing_record FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_actor_kind_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_actor_kind_check
      CHECK (actor_kind IN ('OFFICER', 'OPERATOR', 'MEMBER', 'SYSTEM'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_action_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_action_check
      CHECK (action IN (
        'MEMBER_ERASED',
        'ERASURE_REQUESTED',
        'FLAG_RESOLVED',
        'IMAGE_REMOVED',
        'IMAGE_OVERRIDE_APPROVED',
        'OFFICER_IMAGES_VIEWED',
        'OFFICER_MEMBER_LOOKUP',
        'NOMINEE_READ',
        'REFUND_REQUESTED',
        'HEAD_SUCCEEDED',
        'FAMILY_ARCHIVED',
        'MEMBER_ARCHIVED',
        'MEMBER_UNARCHIVED',
        'SUSPENSION_LIFTED',
        'NOTICE_RESTORED',
        'ARCHIVAL_RESOLVED_BY_OFFICER',
        'ROLE_GRANTED',
        'ROLE_REVOKED',
        'BLOOD_SOS_REPORT_RESOLVED',
        'PASS_REVOKED'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_subject_type_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_subject_type_check
      CHECK (subject_type IN (
        'MEMBER',
        'FAMILY',
        'IMAGE',
        'PAYMENT',
        'NOTICE',
        'FLAG',
        'REGISTRATION',
        'SUSPENSION',
        'ARCHIVAL_REQUEST',
        'BLOOD_SOS',
        'EVENT_PASS'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_actor_id_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_actor_id_check
      CHECK (
        (actor_kind = 'SYSTEM' AND actor_id IS NULL)
        OR (actor_kind <> 'SYSTEM' AND actor_id IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_subject_id_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_subject_id_check
      CHECK (length(subject_id) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_record_retention_check'
  ) THEN
    ALTER TABLE processing_record
      ADD CONSTRAINT processing_record_retention_check
      CHECK (retain_until >= "at");
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION officer_processing_record_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'processing records are append-only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' AND OLD.retain_until > CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'processing records are retained until %', OLD.retain_until
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS processing_record_append_only ON processing_record;
CREATE TRIGGER processing_record_append_only
BEFORE UPDATE OR DELETE ON processing_record
FOR EACH ROW
EXECUTE FUNCTION officer_processing_record_guard();
-- Blood SOS module — concurrency and accounting protections.
CREATE UNIQUE INDEX IF NOT EXISTS blood_sos_one_active_per_member
  ON blood_sos_request (requester_member_id)
  WHERE status = 'ACTIVE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'blood_sos_request_current_tier_ck'
  ) THEN
    ALTER TABLE blood_sos_request
      ADD CONSTRAINT blood_sos_request_current_tier_ck
      CHECK (current_tier BETWEEN 1 AND 3);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'blood_sos_request_reach_nonnegative_ck'
  ) THEN
    ALTER TABLE blood_sos_request
      ADD CONSTRAINT blood_sos_request_reach_nonnegative_ck
      CHECK (donor_reach_total >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'blood_sos_alert_tier_ck'
  ) THEN
    ALTER TABLE blood_sos_alert
      ADD CONSTRAINT blood_sos_alert_tier_ck
      CHECK (tier BETWEEN 1 AND 3);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'blood_sos_alert_accepted_consistent_ck'
  ) THEN
    ALTER TABLE blood_sos_alert
      ADD CONSTRAINT blood_sos_alert_accepted_consistent_ck
      CHECK (accepted IN (TRUE, FALSE));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'donor_alert_day_count_nonnegative_ck'
  ) THEN
    ALTER TABLE donor_alert_day
      ADD CONSTRAINT donor_alert_day_count_nonnegative_ck
      CHECK (count >= 0);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS blood_sos_alert_request_tier_idx
  ON blood_sos_alert (request_id, tier);
CREATE INDEX IF NOT EXISTS blood_sos_response_request_created_idx
  ON blood_sos_response (request_id, created_at);
-- Events module — time, status, pass, and gate-device protections.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_time_order_check'
  ) THEN
    ALTER TABLE event
      ADD CONSTRAINT event_time_order_check CHECK (ends_at > starts_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_status_vocabulary_check'
  ) THEN
    ALTER TABLE event
      ADD CONSTRAINT event_status_vocabulary_check
      CHECK (status IN ('UPCOMING', 'ONGOING', 'ENDED', 'CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_status_vocabulary_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_status_vocabulary_check
      CHECK (status IN ('ACTIVE', 'REVOKED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_minors_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_minors_check
      CHECK (minors_count >= 0 AND minors_count <= 20);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_head_minors_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_head_minors_check
      CHECK (is_head OR minors_count = 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_qr_payload_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_qr_payload_check
      CHECK (length(qr_payload) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_revocation_fields_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_revocation_fields_check
      CHECK (
        (status = 'ACTIVE' AND revoked_at IS NULL AND revoked_reason IS NULL)
        OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_pass_revoked_reason_check'
  ) THEN
    ALTER TABLE event_pass
      ADD CONSTRAINT event_pass_revoked_reason_check
      CHECK (
        revoked_reason IS NULL
        OR revoked_reason IN (
          'EVENT_ENDED',
          'EVENT_CANCELLED',
          'MEMBER_CANCELLED',
          'MEMBER_ERASED',
          'MEMBER_ARCHIVED',
          'OFFICER'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gate_device_label_check'
  ) THEN
    ALTER TABLE gate_device
      ADD CONSTRAINT gate_device_label_check
      CHECK (length(btrim(label)) BETWEEN 1 AND 120);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admission_scanned_at_check'
  ) THEN
    ALTER TABLE admission
      ADD CONSTRAINT admission_scanned_at_check
      CHECK (scanned_at IS NOT NULL);
  END IF;
END;
$$;
-- Runtime application-role privileges. The role is provisioned outside Prisma;
-- migrations never create credentials and the API never connects as the owner.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'agrawal_app'
  ) THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO agrawal_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agrawal_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agrawal_app';

    EXECUTE 'GRANT USAGE ON SCHEMA restricted TO agrawal_app';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA restricted FROM agrawal_app';
    EXECUTE 'GRANT INSERT ON TABLE restricted.member_tombstone, restricted.payment, restricted.refund, restricted.consent_event TO agrawal_app';

    EXECUTE 'GRANT SELECT, INSERT ON TABLE processing_record TO agrawal_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE processing_record FROM agrawal_app';

    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agrawal_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO agrawal_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA restricted REVOKE ALL ON TABLES FROM agrawal_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA restricted GRANT INSERT ON TABLES TO agrawal_app';
  END IF;
END;
$$;
