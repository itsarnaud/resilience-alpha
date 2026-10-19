import { pino, type Logger } from 'pino';

/**
 * Logger JSON sur la sortie standard (Promtail/Loki le récupèrent depuis Docker).
 * Les en-têtes sensibles sont masqués.
 */
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        '*.password',
        'client_secret',
        '*.client_secret',
      ],
      censor: '[masqué]',
    },
  });
}

export type { Logger };
