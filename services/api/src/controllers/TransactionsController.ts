import type { Request, Response } from 'express';
import { HttpError, TransactionRequestSchema } from '@resilience/shared';
import { actorOf } from '../lib/context.js';
import { transactionDto } from '../lib/dto.js';
import {
  IdempotencyKeySchema,
  ListTransactionsQuerySchema,
  TransactionIdParamSchema,
} from '../schemas/payments.schema.js';
import * as TransactionsServices from '../services/TransactionsServices.js';

export const create = async (req: Request, res: Response) => {
  const key = IdempotencyKeySchema.safeParse(req.header('idempotency-key'));
  if (!key.success) throw HttpError.badRequest('en-tête Idempotency-Key (UUID) obligatoire');

  const input = TransactionRequestSchema.parse(req.body);
  const synthetic = req.header('x-synthetic')?.toLowerCase() === 'true';

  const { transaction, replay } = await TransactionsServices.create(
    input,
    key.data,
    synthetic,
    actorOf(req),
  );
  // 201 à la création, 200 si la clé d'idempotence a déjà servi
  res.status(replay ? 200 : 201).json(transactionDto(transaction));
};

export const list = async (req: Request, res: Response) => {
  const { account_id, limit, cursor } = ListTransactionsQuerySchema.parse(req.query);
  const { items, nextCursor } = await TransactionsServices.list(actorOf(req), {
    accountId: account_id,
    limit,
    cursor,
  });
  res.json({ items: items.map(transactionDto), next_cursor: nextCursor });
};

export const show = async (req: Request, res: Response) => {
  const { id } = TransactionIdParamSchema.parse(req.params);
  res.json(transactionDto(await TransactionsServices.get(actorOf(req), id)));
};
