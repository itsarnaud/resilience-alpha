import nodemailer, { type Transporter } from 'nodemailer';
import type { Incident } from '../generated/prisma/client.js';
import { config } from './config.js';
import { logger } from './logger.js';

let transporter: Transporter | undefined;

/** Pas de serveur SMTP configuré (ex. tests) : les notifications sont simplement désactivées. */
const getTransporter = (): Transporter | undefined => {
  if (!config.NOTIFY_SMTP_HOST) return undefined;
  transporter ??= nodemailer.createTransport({
    host: config.NOTIFY_SMTP_HOST,
    port: config.NOTIFY_SMTP_PORT,
    secure: false,
  });
  return transporter;
};

const subjectFor = (incident: Incident, outcome: 'RESOLVED' | 'FAILED'): string =>
  outcome === 'RESOLVED'
    ? `[RESOLU] Incident ${incident.type} — ${incident.sourceIp ?? 'IP inconnue'}`
    : `[ECHEC] Incident ${incident.type} — ${incident.sourceIp ?? 'IP inconnue'}`;

const bodyFor = (incident: Incident, outcome: 'RESOLVED' | 'FAILED'): string =>
  [
    `Incident : ${incident.id}`,
    `Type : ${incident.type}`,
    `IP source : ${incident.sourceIp ?? 'inconnue'}`,
    `Score : ${incident.score ?? 'n/a'}`,
    `Statut : ${outcome}`,
    outcome === 'FAILED' ? `Motif : ${incident.failureReason ?? 'non précisé'}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

/**
 * Notifie l'issue d'un incident par e-mail (résolu ou échoué). Ne bloque jamais la
 * remédiation elle-même : un échec d'envoi est seulement journalisé.
 */
export const notifyIncident = async (
  incident: Incident,
  outcome: 'RESOLVED' | 'FAILED',
): Promise<void> => {
  const transport = getTransporter();
  if (!transport) return;
  try {
    await transport.sendMail({
      from: config.NOTIFY_FROM,
      to: config.NOTIFY_TO,
      subject: subjectFor(incident, outcome),
      text: bodyFor(incident, outcome),
    });
  } catch (err) {
    logger.warn({ err, incident_id: incident.id }, 'notification e-mail impossible');
  }
};
