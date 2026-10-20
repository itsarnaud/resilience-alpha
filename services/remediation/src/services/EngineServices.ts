import { setTimeout as sleep } from 'node:timers/promises';
import type { Incident } from '../generated/prisma/client.js';
import { config } from '../lib/config.js';
import { containers } from '../lib/docker.js';
import { logger } from '../lib/logger.js';
import { canaryTotal } from '../lib/metrics.js';
import { chainFor, isProtectedIp } from '../lib/playbooks.js';
import { isReady, runCanaryTransaction } from '../lib/platform.js';
import { prisma } from '../lib/prisma.js';
import { record } from './ActionsServices.js';
import * as BlocksServices from './BlocksServices.js';
import * as IncidentsServices from './IncidentsServices.js';

interface PlaybookResult {
  /** L'action a été exécutée : on peut vérifier si le service a repris. */
  ok: boolean;
  /** Échec définitif : inutile d'essayer un autre playbook. */
  fatal?: string;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// --- Playbooks ---------------------------------------------------------------------------

/** Bloque l'IP source dans le WAF, sauf si elle est absente ou protégée. */
const blockSource = async (incident: Incident): Promise<PlaybookResult> => {
  const ip = incident.sourceIp;
  if (!ip) {
    await record(incident.id, 'validate_ip', false, 'aucune IP source dans le signalement');
    return { ok: false, fatal: "pas d'IP source à bloquer" };
  }
  if (isProtectedIp(ip)) {
    await record(incident.id, 'validate_ip', false, `${ip} est une IP protégée : blocage refusé`);
    return { ok: false, fatal: `IP protégée (${ip}) : blocage refusé` };
  }
  await record(incident.id, 'validate_ip', true, `${ip} peut être bloquée`);

  try {
    const expiresAt = await BlocksServices.blockIp(incident.id, ip, config.BLOCK_DURATION_SECONDS);
    await record(
      incident.id,
      'block_ip',
      true,
      `${ip} bloquée dans le WAF jusqu'à ${expiresAt.toISOString()}`,
    );
    return { ok: true };
  } catch (err) {
    await record(incident.id, 'block_ip', false, `blocage impossible : ${errorMessage(err)}`);
    return { ok: false };
  }
};

/** Redémarre le conteneur du service concerné (liste blanche appliquée par l'adaptateur Docker). */
const restartService = async (incident: Incident): Promise<PlaybookResult> => {
  const name = incident.targetService;
  if (!name) {
    await record(
      incident.id,
      'restart_container',
      false,
      'aucun service cible dans le signalement',
    );
    return { ok: false };
  }
  try {
    await containers.restart(name);
    await record(incident.id, 'restart_container', true, `conteneur ${name} redémarré`);
    return { ok: true };
  } catch (err) {
    await record(
      incident.id,
      'restart_container',
      false,
      `redémarrage de ${name} impossible : ${errorMessage(err)}`,
    );
    return { ok: false };
  }
};

const PLAYBOOK_RUNNERS: Record<string, (incident: Incident) => Promise<PlaybookResult>> = {
  block_source: blockSource,
  restart_service: restartService,
};

// --- Vérification de la reprise ------------------------------------------------------

/**
 * Prouve que le service est utilisable : les services supervisés répondent, puis une vraie
 * transaction de test réussit. Réessaie, car un service qui redémarre met un moment à répondre.
 */
const verifyRecovery = async (incident: Incident): Promise<boolean> => {
  const attempts = config.VERIFY_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const checks = await Promise.all(
      Object.entries(config.SUPERVISED_SERVICES).map(
        async ([name, url]) => [name, await isReady(url)] as const,
      ),
    );
    const notReady = checks.filter(([, ready]) => !ready).map(([name]) => name);

    if (notReady.length > 0) {
      await record(
        incident.id,
        'verify_ready',
        false,
        `essai ${attempt}/${attempts} : ${notReady.join(', ')} ne répond pas`,
      );
    } else {
      await record(incident.id, 'verify_ready', true, 'services prêts');
      try {
        const detail = await runCanaryTransaction();
        canaryTotal.inc({ result: 'ok' });
        await record(incident.id, 'canary_transaction', true, detail);
        return true;
      } catch (err) {
        canaryTotal.inc({ result: 'failed' });
        await record(
          incident.id,
          'canary_transaction',
          false,
          `essai ${attempt}/${attempts} : ${errorMessage(err)}`,
        );
      }
    }
    if (attempt < attempts) await sleep(config.VERIFY_INTERVAL_MS);
  }
  return false;
};

// --- Déroulement d'un incident ----------------------------------------------------------

const fail = async (id: string, reason: string) => {
  await record(id, 'incident_failed', false, reason);
  await IncidentsServices.setState(id, 'FAILED', { failureReason: reason });
};

const run = async (id: string): Promise<void> => {
  const incident = await prisma.incident.findUnique({ where: { id } });
  if (!incident) return;

  await IncidentsServices.setState(id, 'REMEDIATING');
  const chain = chainFor(incident.type as Parameters<typeof chainFor>[0]);

  for (const [index, name] of chain.entries()) {
    await IncidentsServices.setState(id, 'REMEDIATING', { playbook: name });
    const result = await PLAYBOOK_RUNNERS[name]!(incident);

    if (result.fatal) return fail(id, result.fatal);

    // On ne vérifie que si l'action a été exécutée : un blocage raté ne doit jamais être
    // « confirmé » par le simple fait que le service répond encore.
    if (result.ok) {
      await IncidentsServices.setState(id, 'VERIFYING');
      if (await verifyRecovery(incident)) {
        await IncidentsServices.setState(id, 'RESOLVED');
        return;
      }
      await record(id, 'verify', false, `reprise non confirmée après ${name}`);
    }

    const next = chain[index + 1];
    if (next) await record(id, 'escalate', true, `passage au playbook ${next}`);
  }

  await fail(id, 'reprise non confirmée après tous les playbooks');
};

const running = new Set<string>();

/** Lance le traitement d'un incident en arrière-plan (une seule exécution à la fois par incident). */
export const start = (id: string): void => {
  if (running.has(id)) return;
  running.add(id);
  run(id)
    .catch(async (err) => {
      logger.error({ err, incident_id: id }, 'erreur inattendue pendant la remédiation');
      await fail(id, `erreur interne : ${errorMessage(err)}`).catch(() => undefined);
    })
    .finally(() => running.delete(id));
};

/** Au démarrage : reprend les incidents laissés en cours par un redémarrage de la remédiation. */
export const resumeInterrupted = async (): Promise<number> => {
  const stuck = await prisma.incident.findMany({
    where: { state: { in: IncidentsServices.ACTIVE_STATES } },
  });
  for (const incident of stuck) {
    await record(incident.id, 'resume', true, 'reprise du traitement après redémarrage');
    start(incident.id);
  }
  return stuck.length;
};
