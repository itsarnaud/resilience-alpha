import { config } from '../lib/config.js';
import { backofficeLockouts } from '../lib/metrics.js';
import { prisma } from '../lib/prisma.js';

export type Block =
  { blocked: false } | { blocked: true; reason: 'locked' | 'cooldown'; retryAfterSeconds: number };

const seconds = (until: Date, now: Date) =>
  Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));

/** L'identifiant peut-il démarrer une connexion ? Verrouillé, ou en attente après un refus ? */
export async function check(identifier: string): Promise<Block> {
  const row = await prisma.backofficeLockout.findUnique({ where: { identifier } });
  const now = new Date();
  if (row?.lockedUntil && row.lockedUntil > now) {
    return { blocked: true, reason: 'locked', retryAfterSeconds: seconds(row.lockedUntil, now) };
  }
  if (row?.cooldownUntil && row.cooldownUntil > now) {
    return {
      blocked: true,
      reason: 'cooldown',
      retryAfterSeconds: seconds(row.cooldownUntil, now),
    };
  }
  return { blocked: false };
}

export interface FailureOutcome {
  locked: boolean;
  /** Secondes avant de pouvoir recommencer (verrouillage ou délai après refus). */
  retryAfterSeconds: number;
  level: number;
}

/**
 * Enregistre un échec (visage refusé ou mot de passe refusé). Après `BACKOFFICE_MAX_FAILURES` échecs
 * consécutifs, l'identifiant est verrouillé ; la durée double à chaque verrouillage, jusqu'au plafond.
 * Sinon, un délai court est imposé avant de pouvoir ressaisir l'identifiant.
 *
 * La ligne est verrouillée le temps du calcul : deux échecs simultanés ne peuvent pas se compter
 * comme un seul pour contourner le verrouillage.
 */
export async function recordFailure(
  identifier: string,
  cooldownSeconds: number,
): Promise<FailureOutcome> {
  const outcome = await prisma.$transaction(async (db) => {
    // Création atomique : l'`upsert` de Prisma n'est pas à l'abri de deux créations simultanées (P2002),
    // et une erreur 500 ou un échec perdu permettrait de contourner le verrouillage en parallélisant.
    await db.$executeRaw`
      INSERT INTO backoffice_lockouts (identifier, consecutive_failures, lock_level, updated_at)
      VALUES (${identifier}, 0, 0, now())
      ON CONFLICT (identifier) DO NOTHING`;
    await db.$queryRaw`SELECT identifier FROM backoffice_lockouts WHERE identifier = ${identifier} FOR UPDATE`;
    const row = await db.backofficeLockout.findUniqueOrThrow({ where: { identifier } });

    const now = new Date();
    // Longtemps sans échec : on repart de zéro.
    const stale =
      row.lastFailureAt !== null &&
      now.getTime() - row.lastFailureAt.getTime() > config.BACKOFFICE_LOCK_RESET_SECONDS * 1000;
    let level = stale ? 0 : row.lockLevel;
    let failures = (stale ? 0 : row.consecutiveFailures) + 1;

    if (failures >= config.BACKOFFICE_MAX_FAILURES) {
      level += 1;
      failures = 0;
      const lockSeconds = Math.min(
        config.BACKOFFICE_LOCK_SECONDS * 2 ** (level - 1),
        config.BACKOFFICE_LOCK_MAX_SECONDS,
      );
      const lockedUntil = new Date(now.getTime() + lockSeconds * 1000);
      await db.backofficeLockout.update({
        where: { identifier },
        data: {
          consecutiveFailures: 0,
          lockLevel: level,
          lockedUntil,
          cooldownUntil: null,
          lastFailureAt: now,
        },
      });
      return { locked: true, retryAfterSeconds: Math.ceil(lockSeconds), level };
    }

    const cooldownUntil =
      cooldownSeconds > 0 ? new Date(now.getTime() + cooldownSeconds * 1000) : null;
    await db.backofficeLockout.update({
      where: { identifier },
      data: { consecutiveFailures: failures, lockLevel: level, cooldownUntil, lastFailureAt: now },
    });
    return { locked: false, retryAfterSeconds: Math.ceil(cooldownSeconds), level };
  });

  if (outcome.locked) backofficeLockouts.inc();
  return outcome;
}

/** Connexion réussie : les compteurs repartent de zéro. */
export const recordSuccess = (identifier: string) =>
  prisma.backofficeLockout.deleteMany({ where: { identifier } });

/** Supprime les lignes anciennes (un attaquant qui essaie des milliers d'identifiants ne doit pas remplir la base). */
export const purgeStale = () =>
  prisma.backofficeLockout.deleteMany({
    where: {
      updatedAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
    },
  });
