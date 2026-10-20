import { HttpError } from '@resilience/shared';
import type { Beneficiary } from '../generated/prisma/client.js';
import type { Actor } from '../lib/context.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export const add = async (actor: Actor, iban: string, label: string): Promise<Beneficiary> => {
  const exists = await prisma.beneficiary.findUnique({
    where: { ownerId_iban: { ownerId: actor.sub, iban } },
  });
  if (exists) throw HttpError.conflict('ce bénéficiaire existe déjà');

  const beneficiary = await prisma.beneficiary.create({
    data: { ownerId: actor.sub, iban, label },
  });
  logger.info(
    { event: 'beneficiary_added', user: actor.sub, iban, request_id: actor.requestId },
    'bénéficiaire ajouté',
  );
  return beneficiary;
};

export const list = (actor: Actor): Promise<Beneficiary[]> =>
  prisma.beneficiary.findMany({ where: { ownerId: actor.sub }, orderBy: { createdAt: 'asc' } });
