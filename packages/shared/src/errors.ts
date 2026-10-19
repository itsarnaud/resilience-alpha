import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import type { Logger } from './logger.js';

/** Erreur métier renvoyée au client au format RFC 9457 (`application/problem+json`). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly title: string,
    public readonly detail?: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
    this.name = 'HttpError';
  }

  static badRequest(detail?: string) {
    return new HttpError(400, 'Requête invalide', detail);
  }
  static unauthorized(detail?: string) {
    return new HttpError(401, 'Non authentifié', detail);
  }
  static forbidden(detail?: string, extra?: Record<string, unknown>) {
    return new HttpError(403, 'Accès refusé', detail, extra);
  }
  static notFound(detail?: string) {
    return new HttpError(404, 'Introuvable', detail);
  }
  static conflict(detail?: string) {
    return new HttpError(409, 'Conflit', detail);
  }
  static tooManyRequests(detail?: string) {
    return new HttpError(429, 'Trop de requêtes', detail);
  }
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  request_id?: string;
  [key: string]: unknown;
}

type ProblemBody = Omit<Problem, 'request_id' | 'status'> & { status: number };

function send(res: Response, requestId: string | undefined, problem: ProblemBody) {
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({ ...problem, request_id: requestId });
}

/** 404 pour toute route non définie. */
export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    send(res, req.id, {
      type: 'about:blank',
      title: 'Introuvable',
      status: 404,
      detail: `${req.method} ${req.path}`,
    });
  };
}

/** À monter en dernier : transforme toute erreur en réponse problem+json. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof HttpError) {
      send(res, req.id, {
        type: 'about:blank',
        title: err.title,
        status: err.status,
        detail: err.detail,
        ...err.extra,
      });
      return;
    }

    if (err instanceof ZodError) {
      send(res, req.id, {
        type: 'about:blank',
        title: 'Données invalides',
        status: 422,
        detail: err.issues
          .map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`)
          .join(' ; '),
      });
      return;
    }

    // middlewares Express
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      send(res, req.id, { type: 'about:blank', title: 'Requête invalide', status });
      return;
    }

    logger.error({ err, request_id: req.id, path: req.path }, 'erreur non gérée');
    send(res, req.id, { type: 'about:blank', title: 'Erreur interne', status: 500 });
  };
}
