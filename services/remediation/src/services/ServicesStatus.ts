import { config } from '../lib/config.js';
import { isReady } from '../lib/platform.js';
import { prisma } from '../lib/prisma.js';

/** État des services supervisés, et date de la dernière transaction de test réussie. */
export const list = async () => {
  const lastCanary = await prisma.action.findFirst({
    where: { step: 'canary_transaction', ok: true },
    orderBy: { at: 'desc' },
  });
  const checkedAt = new Date().toISOString();
  return Promise.all(
    Object.entries(config.SUPERVISED_SERVICES).map(async ([name, url]) => ({
      name,
      healthy: await isReady(url),
      last_check_at: checkedAt,
      last_canary_ok_at: lastCanary?.at.toISOString() ?? null,
    })),
  );
};
