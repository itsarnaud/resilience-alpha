import { HttpError } from '@resilience/shared';
import { logger } from '../lib/logger.js';
import { activeBlocks } from '../lib/metrics.js';
import { prisma } from '../lib/prisma.js';
import { waf } from '../lib/waf.js';

// Les écritures de la liste du WAF passent une par une : jamais deux écritures qui se croisent.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(task: () => Promise<T>): Promise<T> => {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
};

const activeWhere = { releasedAt: null } as const;

/** Publie dans le WAF la liste complète des IP actuellement bloquées (source de vérité : la base). */
export const syncWaf = (): Promise<void> =>
  serial(async () => {
    const blocks = await prisma.ipBlock.findMany({ where: activeWhere, select: { ip: true } });
    const ips = [...new Set(blocks.map((b) => b.ip))].sort();
    await waf.publish(ips);
    activeBlocks.set(ips.length);
  });

/** Bloque une IP pour `ttlSeconds` (prolonge un blocage déjà actif) puis met à jour le WAF. */
export const blockIp = async (
  incidentId: string,
  ip: string,
  ttlSeconds: number,
): Promise<Date> => {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const existing = await prisma.ipBlock.findFirst({ where: { ip, ...activeWhere } });
  if (existing) {
    const latest = existing.expiresAt > expiresAt ? existing.expiresAt : expiresAt;
    await prisma.ipBlock.update({ where: { id: existing.id }, data: { expiresAt: latest } });
  } else {
    await prisma.ipBlock.create({ data: { ip, incidentId, expiresAt } });
  }
  await syncWaf();
  logger.warn(
    { event: 'ip_blocked', ip, incident_id: incidentId, expires_at: expiresAt },
    'IP bloquée',
  );
  return expiresAt;
};

/** Lève les blocages arrivés à échéance. Renvoie le nombre d'IP débloquées. */
export const releaseExpired = async (): Promise<number> => {
  const expired = await prisma.ipBlock.findMany({
    where: { ...activeWhere, expiresAt: { lte: new Date() } },
  });
  if (expired.length === 0) return 0;
  await prisma.ipBlock.updateMany({
    where: { id: { in: expired.map((b) => b.id) } },
    data: { releasedAt: new Date() },
  });
  await syncWaf();
  for (const block of expired) {
    logger.info(
      { event: 'ip_unblocked', ip: block.ip, incident_id: block.incidentId },
      'IP débloquée',
    );
  }
  return expired.length;
};

export const listActive = () =>
  prisma.ipBlock.findMany({ where: activeWhere, orderBy: { createdAt: 'desc' } });

/**
 * Lève un blocage avant son échéance, à la demande d'un opérateur (ex. faux positif, besoin de
 * retester). `updateMany` avec le filtre d'activité : lever un blocage déjà levé ou inexistant
 * renvoie proprement 404, sans écraser une levée concurrente.
 */
export const releaseOne = async (id: string, by: string): Promise<void> => {
  const { count } = await prisma.ipBlock.updateMany({
    where: { id, ...activeWhere },
    data: { releasedAt: new Date() },
  });
  if (count === 0) throw HttpError.notFound('blocage introuvable ou déjà levé');
  const block = await prisma.ipBlock.findUniqueOrThrow({ where: { id } });
  await syncWaf();
  logger.warn(
    { event: 'ip_unblocked_manually', ip: block.ip, incident_id: block.incidentId, by },
    'IP débloquée manuellement',
  );
};
