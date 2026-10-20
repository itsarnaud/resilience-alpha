-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('COMPLETED', 'REJECTED');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "balance_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beneficiaries" (
    "id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beneficiaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "from_account_id" UUID NOT NULL,
    "to_account_id" UUID,
    "to_iban" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "label" TEXT,
    "status" "TransactionStatus" NOT NULL,
    "reject_reason" TEXT,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_iban_key" ON "accounts"("iban");

-- CreateIndex
CREATE INDEX "accounts_owner_id_idx" ON "accounts"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "beneficiaries_owner_id_iban_key" ON "beneficiaries"("owner_id", "iban");

-- CreateIndex
CREATE INDEX "transactions_from_account_id_created_at_idx" ON "transactions"("from_account_id", "created_at");

-- CreateIndex
CREATE INDEX "transactions_to_account_id_created_at_idx" ON "transactions"("to_account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_created_by_idempotency_key_key" ON "transactions"("created_by", "idempotency_key");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_from_account_id_fkey" FOREIGN KEY ("from_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Défense en profondeur : un solde ne peut jamais être négatif, même en cas de bug applicatif.
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_balance_non_negative" CHECK ("balance_cents" >= 0);
-- Un virement a exactement une destination : un compte interne OU un IBAN.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_one_destination"
  CHECK (("to_account_id" IS NOT NULL) <> ("to_iban" IS NOT NULL));
-- Montant strictement positif.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount_cents" > 0);
