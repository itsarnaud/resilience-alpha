import { z } from 'zod';

export const IdempotencyKeySchema = z.uuid();

export const ListTransactionsQuerySchema = z.object({
  account_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});

export const CreateBeneficiarySchema = z.object({
  iban: z
    .string()
    .transform((s) => s.replace(/\s+/g, '').toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, 'IBAN invalide')),
  label: z.string().min(1).max(100),
});

export const AccountIdParamSchema = z.object({ id: z.uuid() });
export const TransactionIdParamSchema = z.object({ id: z.uuid() });
