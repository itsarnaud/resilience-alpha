import { HttpError } from '@resilience/shared';
import type { Account } from '../generated/prisma/client.js';
import { config } from '../lib/config.js';
import type { Actor } from '../lib/context.js';
import { generateIban } from '../lib/iban.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export const open = async (actor: Actor): Promise<Account> => {
  const count = await prisma.account.count({ where: { ownerId: actor.sub } });
  if (count >= config.MAX_ACCOUNTS_PER_USER) {
    throw HttpError.conflict(`maximum ${config.MAX_ACCOUNTS_PER_USER} comptes par client`);
  }
  const account = await prisma.account.create({
    data: {
      ownerId: actor.sub,
      iban: generateIban(),
      balanceCents: config.INITIAL_BALANCE_CENTS,
    },
  });
  logger.info(
    {
      event: 'account_opened',
      account_id: account.id,
      user: actor.sub,
      request_id: actor.requestId,
    },
    'compte ouvert',
  );
  return account;
};

export const list = (actor: Actor): Promise<Account[]> =>
  prisma.account.findMany({ where: { ownerId: actor.sub }, orderBy: { createdAt: 'asc' } });

export const get = async (actor: Actor, id: string): Promise<Account> => {
  const account = await prisma.account.findUnique({ where: { id } });
  if (!account || account.ownerId !== actor.sub) throw HttpError.notFound('compte introuvable');
  return account;
};
