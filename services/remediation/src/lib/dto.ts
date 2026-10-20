import type { Action, Incident } from '../generated/prisma/client.js';

export type IncidentWithActions = Incident & { actions: Action[] };

// Les routes exposent du snake_case (voir docs/api/remediation.openapi.yaml).
export const incidentDto = (i: IncidentWithActions) => ({
  id: i.id,
  type: i.type,
  state: i.state,
  score: i.score,
  target_service: i.targetService,
  source_ip: i.sourceIp,
  targets: i.targets,
  stats: i.stats,
  playbook: i.playbook,
  failure_reason: i.failureReason,
  detected_at: i.detectedAt.toISOString(),
  resolved_at: i.resolvedAt?.toISOString() ?? null,
  time_to_recover_seconds: i.resolvedAt
    ? Math.round(((i.resolvedAt.getTime() - i.detectedAt.getTime()) / 1000) * 10) / 10
    : null,
  timeline: [...i.actions]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((a) => ({ at: a.at.toISOString(), step: a.step, ok: a.ok, detail: a.detail })),
});
