-- CreateEnum
CREATE TYPE "BackofficeLoginState" AS ENUM ('IDENTIFIED', 'PASSWORD_PENDING', 'GRANTED', 'FACE_REFUSED', 'PASSWORD_REFUSED', 'EXPIRED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "backoffice_logins" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "user_id" UUID,
    "state" "BackofficeLoginState" NOT NULL DEFAULT 'IDENTIFIED',
    "ip" TEXT NOT NULL,
    "face_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "backoffice_logins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backoffice_lockouts" (
    "identifier" TEXT NOT NULL,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "lock_level" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "cooldown_until" TIMESTAMP(3),
    "last_failure_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backoffice_lockouts_pkey" PRIMARY KEY ("identifier")
);

-- CreateIndex
CREATE INDEX "backoffice_logins_identifier_created_at_idx" ON "backoffice_logins"("identifier", "created_at");

-- CreateIndex
CREATE INDEX "backoffice_logins_state_expires_at_idx" ON "backoffice_logins"("state", "expires_at");

-- AddForeignKey
ALTER TABLE "backoffice_logins" ADD CONSTRAINT "backoffice_logins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
