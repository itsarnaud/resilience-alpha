import { HttpError, type IncidentReport, type IncidentState } from '@resilience/shared';
import type { Incident } from '../generated/prisma/client.js';
import type { IncidentWithActions } from '../lib/dto.js';
import type { Actor } from '../lib/context.js';
import { logger } from '../lib/logger.js';
import { incidentsTotal, recoverySeconds } from '../lib/metrics.js';
import { evaluatePolicy } from '../lib/playbooks.js';
import { config } from '../lib/config.js';
import { prisma } from '../lib/prisma.js';
import * as ActionsServices from './ActionsServices.js';

export const ACTIVE_STATES: IncidentState[] = ['DETECTED', 'REMEDIATING', 'VERIFYING'];

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

/** Incident déjà en cours pour cette clé, ou résolu depuis très peu de temps. */
const findDuplicate = (dedupKey: string): Promise<IncidentWithActions | null> => {
  const cutoff = new Date(Date.now() - config.DEDUP_COOLDOWN_SECONDS * 1000);
  return prisma.incident.findFirst({
    where: {
      dedupKey,
      OR: [{ state: { in: ACTIVE_STATES } }, { state: 'RESOLVED', resolvedAt: { gte: cutoff } }],
    },
    orderBy: { createdAt: 'desc' },
    include: { actions: true },
  });
};

export const get = async (id: string): Promise<IncidentWithActions> => {
  const incident = await prisma.incident.findUnique({ where: { id }, include: { actions: true } });
  if (!incident) throw HttpError.notFound('incident introuvable');
  return incident;
};

export const list = (filter: { state?: IncidentState; limit: number }) =>
  prisma.incident.findMany({
    where: filter.state ? { state: filter.state } : {},
    orderBy: { createdAt: 'desc' },
    take: filter.limit,
    include: { actions: true },
  });

/**
 * Enregistre un signalement du détecteur. Idempotent sur la clé de dédoublonnage : un incident déjà
 * en cours (ou tout juste résolu) est renvoyé tel quel. La politique décide ensuite si on agit.
 */
export const create = async (
  report: IncidentReport,
  actor: Actor,
): Promise<{ incident: IncidentWithActions; created: boolean }> => {
  const dedupKey =
    report.dedup_key ?? `${report.type}:${report.source_ip ?? report.target_service ?? 'global'}`;

  const duplicate = await findDuplicate(dedupKey);
  if (duplicate) return { incident: duplicate, created: false };

  const decision = evaluatePolicy(report);

  let id: string;
  try {
    const created = await prisma.incident.create({
      data: {
        dedupKey,
        type: report.type,
        score: report.score,
        targetService: report.target_service,
        sourceIp: report.source_ip ?? undefined,
        targets: report.targets,
        stats: report.stats ?? undefined,
        evidence: report.evidence,
        detectedAt: new Date(report.detected_at),
        state: decision.act ? 'DETECTED' : 'IGNORED',
      },
    });
    id = created.id;
  } catch (err) {
    // Deux signalements simultanés pour la même clé : l'index unique en laisse passer un seul.
    if (isUniqueViolation(err)) {
      const concurrent = await findDuplicate(dedupKey);
      if (concurrent) return { incident: concurrent, created: false };
    }
    throw err;
  }

  incidentsTotal.inc({ type: report.type, state: decision.act ? 'DETECTED' : 'IGNORED' });
  logger.info(
    {
      event: 'incident_created',
      incident_id: id,
      type: report.type,
      score: report.score,
      source_ip: report.source_ip ?? null,
      targets: report.targets,
      stats: report.stats ?? null,
      acted: decision.act,
      by: actor.sub,
      request_id: actor.requestId,
    },
    decision.act ? 'incident reçu' : 'incident reçu, aucune action (politique)',
  );

  await ActionsServices.record(
    id,
    'incident_received',
    true,
    `reçu de ${actor.sub} (type ${report.type}, score ${report.score})`,
  );
  if (!decision.act)
    await ActionsServices.record(id, 'policy', true, `ignoré : ${decision.reason}`);

  return { incident: await get(id), created: true };
};

/** Change l'état d'un incident, met à jour les métriques et prévient les clients du flux temps réel. */
export const setState = async (
  id: string,
  state: IncidentState,
  patch: { playbook?: string; failureReason?: string } = {},
): Promise<Incident> => {
  const now = new Date();
  const incident = await prisma.incident.update({
    where: { id },
    data: {
      state,
      ...(patch.playbook !== undefined ? { playbook: patch.playbook } : {}),
      ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
      ...(state === 'RESOLVED' ? { resolvedAt: now } : {}),
    },
  });
  incidentsTotal.inc({ type: incident.type, state });

  if (state === 'RESOLVED') {
    const seconds = (now.getTime() - incident.detectedAt.getTime()) / 1000;
    recoverySeconds.observe(seconds);
    logger.info(
      { event: 'incident_resolved', incident_id: id, type: incident.type, seconds },
      'incident résolu, reprise confirmée',
    );
  } else if (state === 'FAILED') {
    logger.error(
      {
        event: 'incident_failed',
        incident_id: id,
        type: incident.type,
        reason: patch.failureReason,
      },
      'incident non résolu',
    );
  }
  await ActionsServices.publish(id);
  return incident;
};
