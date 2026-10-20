-- CreateEnum
CREATE TYPE "IncidentState" AS ENUM ('DETECTED', 'REMEDIATING', 'VERIFYING', 'RESOLVED', 'FAILED', 'IGNORED');

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "state" "IncidentState" NOT NULL DEFAULT 'DETECTED',
    "score" DOUBLE PRECISION NOT NULL,
    "target_service" TEXT,
    "source_ip" TEXT,
    "targets" TEXT[],
    "stats" JSONB,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "playbook" TEXT,
    "failure_reason" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actions" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "step" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "detail" TEXT NOT NULL,

    CONSTRAINT "actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_blocks" (
    "id" UUID NOT NULL,
    "ip" TEXT NOT NULL,
    "incident_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "ip_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incidents_dedup_key_created_at_idx" ON "incidents"("dedup_key", "created_at");

-- CreateIndex
CREATE INDEX "incidents_state_idx" ON "incidents"("state");

-- CreateIndex
CREATE INDEX "actions_incident_id_at_idx" ON "actions"("incident_id", "at");

-- CreateIndex
CREATE INDEX "actions_step_ok_at_idx" ON "actions"("step", "ok", "at");

-- CreateIndex
CREATE INDEX "ip_blocks_released_at_expires_at_idx" ON "ip_blocks"("released_at", "expires_at");

-- CreateIndex
CREATE INDEX "ip_blocks_ip_idx" ON "ip_blocks"("ip");

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ip_blocks" ADD CONSTRAINT "ip_blocks_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Défense en profondeur : une IP bloquée ne peut avoir qu'une seule ligne active.
CREATE UNIQUE INDEX "ip_blocks_one_active_per_ip" ON "ip_blocks" ("ip") WHERE "released_at" IS NULL;
-- Un score est toujours compris entre 0 et 1.
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_score_range" CHECK ("score" >= 0 AND "score" <= 1);
-- Un seul incident actif par clé de dédoublonnage : deux envois simultanés du détecteur ne créent pas
-- deux traitements du même incident.
CREATE UNIQUE INDEX "incidents_one_active_per_key" ON "incidents" ("dedup_key")
  WHERE "state" IN ('DETECTED', 'REMEDIATING', 'VERIFYING');
