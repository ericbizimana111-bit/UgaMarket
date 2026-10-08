-- "Continue with Google": link a customer to their Google account (OIDC "sub").
-- Nullable, so existing phone-only accounts are unaffected.
ALTER TABLE "users" ADD COLUMN "google_id" VARCHAR(64);

CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");
