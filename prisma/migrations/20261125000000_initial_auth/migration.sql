CREATE TYPE "Role" AS ENUM ('HQ_ADMIN', 'OUTLET_STAFF');
CREATE TYPE "SessionRevokeReason" AS ENUM ('LOGOUT', 'ROTATED', 'REPLAY_DETECTED', 'ADMIN_REVOKED', 'EXPIRED');

CREATE TABLE "users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" VARCHAR(320) NOT NULL,
  "password_hash" VARCHAR(255) NOT NULL,
  "role" "Role" NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refresh_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "family_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "user_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  "revoke_reason" "SessionRevokeReason",
  "user_agent" VARCHAR(512),
  "ip_address" INET,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ(3),
  CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_is_active_idx" ON "users"("is_active");
CREATE UNIQUE INDEX "refresh_sessions_token_hash_key" ON "refresh_sessions"("token_hash");
CREATE INDEX "refresh_sessions_user_id_revoked_at_idx" ON "refresh_sessions"("user_id", "revoked_at");
CREATE INDEX "refresh_sessions_family_id_idx" ON "refresh_sessions"("family_id");
CREATE INDEX "refresh_sessions_expires_at_idx" ON "refresh_sessions"("expires_at");
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
