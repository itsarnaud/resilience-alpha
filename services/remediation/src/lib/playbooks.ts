import { isIP } from 'node:net';
import type { IncidentReport, IncidentType } from '@resilience/shared';
import { config } from './config.js';

export interface PlaybookDefinition {
  name: string;
  description: string;
  handles: IncidentType[];
  steps: string[];
}

export const PLAYBOOKS: PlaybookDefinition[] = [
  {
    name: 'block_source',
    description: "Bloque temporairement l'IP source dans le WAF",
    handles: ['BRUTE_FORCE', 'HTTP_FLOOD'],
    steps: ['validate_ip', 'block_ip', 'verify_ready', 'canary_transaction'],
  },
  {
    name: 'restart_service',
    description: 'Redémarre le conteneur du service concerné',
    handles: ['SERVICE_DOWN', 'HTTP_FLOOD'],
    steps: ['restart_container', 'verify_ready', 'canary_transaction'],
  },
];

/**
 * Ordre des playbooks essayés. Le premier agit sur la cause (la source), le suivant est un filet
 * de sécurité si la reprise n'est pas confirmée.
 */
export function chainFor(type: IncidentType): string[] {
  switch (type) {
    case 'BRUTE_FORCE':
      return ['block_source'];
    case 'HTTP_FLOOD':
      return ['block_source', 'restart_service'];
    case 'SERVICE_DOWN':
      return ['restart_service'];
    default:
      return [];
  }
}

export const isProtectedIp = (ip: string): boolean =>
  isIP(ip) !== 0 && config.PROTECTED_IPS.includes(ip);

export interface PolicyDecision {
  act: boolean;
  reason: string;
}

/**
 * Décide si on agit. Le score du détecteur indique une anomalie, pas une certitude : on exige
 * un score suffisant et, pour un brute force avec statistiques, assez d'échecs observés.
 */
export function evaluatePolicy(report: IncidentReport): PolicyDecision {
  if (chainFor(report.type).length === 0) {
    return { act: false, reason: `aucun playbook pour le type ${report.type}` };
  }
  if (report.score < config.MIN_SCORE) {
    return { act: false, reason: `score ${report.score} inférieur au seuil ${config.MIN_SCORE}` };
  }
  const failures = report.stats?.failures;
  if (report.type === 'BRUTE_FORCE' && failures !== undefined && failures < config.MIN_FAILURES) {
    return {
      act: false,
      reason: `${failures} échecs observés, seuil ${config.MIN_FAILURES}`,
    };
  }
  return { act: true, reason: `score ${report.score}, actions autorisées` };
}
