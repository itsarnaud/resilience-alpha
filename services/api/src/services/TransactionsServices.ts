import { HttpError, type TransactionRequest } from '@resilience/shared';
import { Prisma, type Account, type Transaction } from '../generated/prisma/client.js';
import { config } from '../lib/config.js';
import type { Actor } from '../lib/context.js';
import { FRAUD_MESSAGES, evaluateIbanTransfer, type FraudReason } from '../lib/fraud.js';
import { normalizeIban } from '../lib/iban.js';
import { logger } from '../lib/logger.js';
import { fraudBlocked, transactionsTotal } from '../lib/metrics.js';
import { prisma } from '../lib/prisma.js';

const CANARY_ROLE = 'svc:remediation-canary';

export interface CreateResult {
  transaction: Transaction;
  /** `true` si la clé d'idempotence avait déjà servi : on renvoie le virement d'origine. */
  replay: boolean;
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

const withLockedAccounts = <T>(
  accountIds: string[],
  work: (db: Prisma.TransactionClient) => Promise<T>,
): Promise<T> =>
  prisma.$transaction(async (db) => {
    await db.$queryRaw(
      Prisma.sql`SELECT id FROM accounts WHERE id IN (${Prisma.join(accountIds)}) ORDER BY id FOR UPDATE`,
    );
    return work(db);
  });

/** Exécute un virement : contrôle du solde, débit, crédit et journal, dans une même transaction. */
export const create = async (
  input: TransactionRequest,
  idempotencyKey: string,
  synthetic: boolean,
  actor: Actor,
): Promise<CreateResult> => {
  // Transaction de test (canari) : réservée au rôle de la remédiation, et limitée aux comptes internes.
  const isCanary = actor.roles.includes(CANARY_ROLE);
  if (synthetic !== isCanary) {
    throw HttpError.forbidden(
      isCanary ? 'le canari doit envoyer X-Synthetic: true' : 'X-Synthetic est réservé au canari',
    );
  }
  if (isCanary && input.to_iban) {
    throw HttpError.forbidden('le canari ne peut virer que vers un compte interne');
  }

  const replayOf = async (): Promise<CreateResult | null> => {
    const existing = await prisma.transaction.findUnique({
      where: { createdBy_idempotencyKey: { createdBy: actor.sub, idempotencyKey } },
    });
    if (!existing) return null;
    const sameRequest =
      existing.fromAccountId === input.from_account_id &&
      existing.amountCents === input.amount_cents;
    if (!sameRequest)
      throw HttpError.conflict('Idempotency-Key déjà utilisée avec un autre contenu');
    return { transaction: existing, replay: true };
  };

  const replay = await replayOf();
  if (replay) return replay;

  const from = await prisma.account.findUnique({ where: { id: input.from_account_id } });
  if (!from || from.ownerId !== actor.sub) throw HttpError.notFound('compte source introuvable');

  // Destination : compte interne (par id) ou IBAN (qui peut quand même désigner un compte interne).
  const iban = input.to_iban ? normalizeIban(input.to_iban) : undefined;
  let to: Account | null = null;
  if (input.to_account_id) {
    to = await prisma.account.findUnique({ where: { id: input.to_account_id } });
    if (!to) throw HttpError.notFound('compte destinataire introuvable');
  } else if (iban) {
    to = await prisma.account.findUnique({ where: { iban } });
  }
  if (to?.id === from.id) throw HttpError.badRequest('compte source et destinataire identiques');

  const kind = iban ? 'iban' : 'internal';
  const amount = input.amount_cents;
  const lockIds = [from.id, ...(to ? [to.id] : [])];

  const recordData = {
    fromAccountId: from.id,
    toAccountId: to?.id ?? null,
    toIban: to ? null : (iban ?? null),
    amountCents: amount,
    label: input.label,
    synthetic,
    createdBy: actor.sub,
  };
  const rejectedRow = (reason: string) =>
    ({ ...recordData, status: 'REJECTED', rejectReason: reason }) as const;

  // --- Règle anti-fraude : virement par IBAN vers un compte qui n'est pas à l'émetteur ---
  if (iban && to?.ownerId !== actor.sub) {
    const known = await prisma.beneficiary.findUnique({
      where: { ownerId_iban: { ownerId: actor.sub, iban } },
    });
    const reason: FraudReason | null = evaluateIbanTransfer({
      amountCents: amount,
      knownBeneficiary: Boolean(known),
      limitCents: config.EXTERNAL_TRANSFER_LIMIT_CENTS,
    });
    if (reason) {
      await withLockedAccounts(lockIds, (db) =>
        db.transaction.create({ data: rejectedRow(reason) }),
      );
      transactionsTotal.inc({ status: 'rejected', kind });
      fraudBlocked.inc({ reason });
      logger.warn(
        {
          event: 'fraud_blocked',
          reason,
          user: actor.sub,
          from_account_id: from.id,
          to_iban: iban,
          amount_cents: amount,
          ip: actor.ip,
          request_id: actor.requestId,
        },
        'virement refusé par la règle anti-fraude',
      );
      throw HttpError.forbidden(FRAUD_MESSAGES[reason], { reason });
    }
  }

  try {
    const outcome = await withLockedAccounts(lockIds, async (db) => {
      // Solde relu après verrouillage : c'est la valeur à jour.
      const fresh = await db.account.findUniqueOrThrow({ where: { id: from.id } });
      if (fresh.balanceCents < amount) {
        await db.transaction.create({ data: rejectedRow('insufficient_funds') });
        return { insufficient: true as const };
      }

      await db.account.update({
        where: { id: from.id },
        data: { balanceCents: { decrement: amount } },
      });
      if (to) {
        await db.account.update({
          where: { id: to.id },
          data: { balanceCents: { increment: amount } },
        });
      }
      const transaction = await db.transaction.create({
        data: { ...recordData, status: 'COMPLETED', idempotencyKey },
      });
      return { insufficient: false as const, transaction };
    });

    if (outcome.insufficient) {
      transactionsTotal.inc({ status: 'rejected', kind });
      logger.warn(
        {
          event: 'transaction_rejected',
          reason: 'insufficient_funds',
          user: actor.sub,
          request_id: actor.requestId,
        },
        'virement refusé : fonds insuffisants',
      );
      throw new HttpError(402, 'Fonds insuffisants', 'le solde ne couvre pas ce virement', {
        reason: 'insufficient_funds',
      });
    }

    transactionsTotal.inc({ status: 'completed', kind });
    logger.info(
      {
        event: 'transaction_completed',
        transaction_id: outcome.transaction.id,
        user: actor.sub,
        from_account_id: from.id,
        to_account_id: to?.id ?? null,
        amount_cents: amount,
        synthetic,
        kind,
        ip: actor.ip,
        request_id: actor.requestId,
      },
      'virement exécuté',
    );
    return { transaction: outcome.transaction, replay: false };
  } catch (err) {
    // Deux requêtes simultanées avec la même clé : la seconde retrouve le virement de la première.
    if (isUniqueViolation(err)) {
      const concurrent = await replayOf();
      if (concurrent) return concurrent;
    }
    throw err;
  }
};

export const list = async (
  actor: Actor,
  query: { accountId?: string; limit: number; cursor?: string },
): Promise<{ items: Transaction[]; nextCursor: string | null }> => {
  const mine = await prisma.account.findMany({
    where: { ownerId: actor.sub },
    select: { id: true },
  });
  const ids = mine.map((a) => a.id);
  if (query.accountId && !ids.includes(query.accountId)) {
    throw HttpError.notFound('compte introuvable');
  }
  const scope = query.accountId ? [query.accountId] : ids;

  const rows = await prisma.transaction.findMany({
    where: { OR: [{ fromAccountId: { in: scope } }, { toAccountId: { in: scope } }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, query.limit);
  return { items, nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null };
};

export const get = async (actor: Actor, id: string): Promise<Transaction> => {
  const transaction = await prisma.transaction.findUnique({ where: { id } });
  if (!transaction) throw HttpError.notFound('transaction introuvable');
  const mine = await prisma.account.count({
    where: {
      ownerId: actor.sub,
      id: {
        in: [
          transaction.fromAccountId,
          ...(transaction.toAccountId ? [transaction.toAccountId] : []),
        ],
      },
    },
  });
  if (mine === 0) throw HttpError.notFound('transaction introuvable');
  return transaction;
};
