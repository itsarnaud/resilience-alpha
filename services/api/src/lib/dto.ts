import type { Account, Beneficiary, Transaction } from '../generated/prisma/client.js';

export const accountDto = (a: Account) => ({
  id: a.id,
  owner_id: a.ownerId,
  iban: a.iban,
  balance_cents: a.balanceCents,
  currency: a.currency,
});

export const beneficiaryDto = (b: Beneficiary) => ({
  id: b.id,
  iban: b.iban,
  label: b.label,
  created_at: b.createdAt.toISOString(),
});

export const transactionDto = (t: Transaction) => ({
  id: t.id,
  from_account_id: t.fromAccountId,
  to_account_id: t.toAccountId,
  to_iban: t.toIban,
  amount_cents: t.amountCents,
  label: t.label,
  status: t.status,
  reject_reason: t.rejectReason,
  synthetic: t.synthetic,
  created_at: t.createdAt.toISOString(),
});
