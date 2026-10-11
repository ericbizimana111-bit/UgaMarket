-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('SIGNUP', 'VERIFY_EMAIL', 'VERIFY_PHONE', 'PASSWORD_RESET', 'CHANGE_EMAIL', 'CHANGE_PHONE');

-- CreateEnum
CREATE TYPE "OtpChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('TERMS', 'PRIVACY', 'MARKETING');

-- CreateEnum
CREATE TYPE "SubscriberStatus" AS ENUM ('PENDING', 'ACTIVE', 'UNSUBSCRIBED');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACTIVE', 'ENDED', 'MISSED', 'REJECTED', 'FAILED');

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "read_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "otp_codes" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "channel" "OtpChannel" NOT NULL DEFAULT 'SMS',
ADD COLUMN     "consumed_at" TIMESTAMP(3),
ADD COLUMN     "delivery_status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
ADD COLUMN     "ip_address" VARCHAR(64),
ADD COLUMN     "max_attempts" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "provider_ref" VARCHAR(150),
ADD COLUMN     "purpose" "OtpPurpose" NOT NULL DEFAULT 'VERIFY_PHONE',
ADD COLUMN     "user_id" UUID,
ALTER COLUMN "phone" SET DATA TYPE VARCHAR(255);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verified_at" TIMESTAMP(3),
ADD COLUMN     "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketing_consent_at" TIMESTAMP(3),
ADD COLUMN     "password_changed_at" TIMESTAMP(3),
ADD COLUMN     "phone_verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "security_events" (
    "id" SERIAL NOT NULL,
    "user_id" UUID,
    "type" VARCHAR(50) NOT NULL,
    "target" VARCHAR(255),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(300),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "order_id" UUID,
    "type" "ConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "version" VARCHAR(40),
    "source" VARCHAR(30) NOT NULL,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_subscribers" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "status" "SubscriberStatus" NOT NULL DEFAULT 'PENDING',
    "confirm_token_hash" VARCHAR(64),
    "confirm_token_expires" TIMESTAMP(3),
    "unsubscribe_token" VARCHAR(64) NOT NULL,
    "language" VARCHAR(5) NOT NULL DEFAULT 'en',
    "source" VARCHAR(30) NOT NULL DEFAULT 'FOOTER',
    "consent_ip" VARCHAR(64),
    "confirmed_at" TIMESTAMP(3),
    "unsubscribed_at" TIMESTAMP(3),
    "last_confirm_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newsletter_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "new_arrivals_digest" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_announced_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "new_arrivals_digest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "admin_id" UUID,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "end_reason" VARCHAR(40),
    "ended_by" VARCHAR(10),
    "answered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_user_id_created_at_idx" ON "security_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "security_events_type_idx" ON "security_events"("type");

-- CreateIndex
CREATE INDEX "consent_records_user_id_type_created_at_idx" ON "consent_records"("user_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "consent_records_order_id_idx" ON "consent_records"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscribers_email_key" ON "newsletter_subscribers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscribers_confirm_token_hash_key" ON "newsletter_subscribers"("confirm_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscribers_unsubscribe_token_key" ON "newsletter_subscribers"("unsubscribe_token");

-- CreateIndex
CREATE INDEX "newsletter_subscribers_status_idx" ON "newsletter_subscribers"("status");

-- CreateIndex
CREATE INDEX "call_sessions_user_id_created_at_idx" ON "call_sessions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "call_sessions_status_idx" ON "call_sessions"("status");

-- CreateIndex
CREATE INDEX "otp_codes_phone_purpose_created_at_idx" ON "otp_codes"("phone", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "otp_codes_provider_ref_idx" ON "otp_codes"("provider_ref");

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: chat history from before receipts existed counts as delivered and read.
UPDATE "chat_messages" SET "delivered_at" = "created_at", "read_at" = "created_at" WHERE "delivered_at" IS NULL;

-- Backfill: Google-created accounts only exist when Google verified the email.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "google_id" IS NOT NULL AND "email" IS NOT NULL AND "email_verified_at" IS NULL;
