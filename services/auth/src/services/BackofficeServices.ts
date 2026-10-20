import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError } from '@resilience/shared';
import type { BackofficeLogin } from '../generated/prisma/client.js';
import { config } from '../lib/config.js';
import type { RequestContext } from '../lib/context.js';
import { FaceServiceError, face } from '../lib/face.js';
import { signer } from '../lib/keys.js';
import { logger } from '../lib/logger.js';
import { backofficeLogins } from '../lib/metrics.js';
import { verifyPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';
import { validRoles } from '../lib/roles.js';
import * as LedServices from './LedServices.js';
import * as LockoutServices from './LockoutServices.js';
import type { TokenResponse } from './AuthServices.js';

const normalize = (identifier: string) => identifier.trim().toLowerCase();

async function eligibleUser(identifier: string) {
  const user = await prisma.user.findUnique({ where: { email: identifier } });
  return user && user.active && user.roles.includes('admin') ? user : null;
}

const expired = (login: BackofficeLogin) => login.expiresAt.getTime() <= Date.now();

async function load(id: string): Promise<BackofficeLogin> {
  const login = await prisma.backofficeLogin.findUnique({ where: { id } });
  if (!login) throw HttpError.notFound('connexion introuvable');
  if ((login.state === 'IDENTIFIED' || login.state === 'PASSWORD_PENDING') && expired(login)) {
    await prisma.backofficeLogin.updateMany({
      where: { id, state: login.state },
      data: { state: 'EXPIRED', finishedAt: new Date() },
    });
    backofficeLogins.inc({ result: 'expired' });
    throw new HttpError(410, 'Connexion expirée', 'recommencez en saisissant votre identifiant', {
      reason: 'expired',
    });
  }
  return login;
}

async function transition(
  login: BackofficeLogin,
  from: BackofficeLogin['state'],
  data: Partial<Pick<BackofficeLogin, 'state' | 'faceDistance' | 'finishedAt'>>,
): Promise<void> {
  const { count } = await prisma.backofficeLogin.updateMany({
    where: { id: login.id, state: from },
    data,
  });
  if (count !== 1) throw HttpError.conflict('cette étape de la connexion a déjà été traitée');
}

const refused = (title: string, reason: string, outcome: LockoutServices.FailureOutcome) =>
  new HttpError(
    401,
    title,
    outcome.locked
      ? `identifiant bloqué pendant ${Math.ceil(outcome.retryAfterSeconds / 60)} min`
      : 'recommencez depuis la saisie de l’identifiant',
    { reason, retry_after_seconds: outcome.retryAfterSeconds, locked: outcome.locked },
  );

// 1

export async function start(rawIdentifier: string, ctx: RequestContext): Promise<BackofficeLogin> {
  const identifier = normalize(rawIdentifier);

  const block = await LockoutServices.check(identifier);
  if (block.blocked) {
    backofficeLogins.inc({ result: 'blocked' });
    logger.warn(
      {
        event: 'backoffice_login_blocked',
        identifier,
        ip: ctx.ip,
        reason: block.reason,
        request_id: ctx.requestId,
      },
      'connexion du back-office refusée : identifiant en attente ou verrouillé',
    );
    throw new HttpError(
      423,
      block.reason === 'locked' ? 'Identifiant bloqué' : 'Veuillez patienter',
      block.reason === 'locked'
        ? `trop d'échecs : réessayez dans ${Math.ceil(block.retryAfterSeconds / 60)} min`
        : `réessayez dans ${block.retryAfterSeconds} s`,
      { reason: block.reason, retry_after_seconds: block.retryAfterSeconds },
    );
  }

  const user = await eligibleUser(identifier);
  const login = await prisma.backofficeLogin.create({
    data: {
      identifier,
      userId: user?.id,
      ip: ctx.ip,
      expiresAt: new Date(Date.now() + config.BACKOFFICE_SESSION_TTL_SECONDS * 1000),
    },
  });
  backofficeLogins.inc({ result: 'started' });
  logger.info(
    {
      event: 'backoffice_login_started',
      identifier,
      ip: ctx.ip,
      login_id: login.id,
      eligible: Boolean(user),
      request_id: ctx.requestId,
    },
    'connexion du back-office : identifiant saisi',
  );
  return login;
}

export const get = (id: string) => load(id);

// 2

export async function submitFace(
  id: string,
  image: Buffer,
  ctx: RequestContext,
): Promise<BackofficeLogin> {
  const login = await load(id);
  if (login.state !== 'IDENTIFIED')
    throw HttpError.conflict('la photo a déjà été traitée pour cette connexion');

  const startedAt = Date.now();
  let result: { match: boolean; distance?: number } = { match: false };
  if (login.userId) {
    try {
      result = await face.verify(login.identifier, image);
    } catch (err) {
      if (!(err instanceof FaceServiceError)) throw err;
      logger.error(
        {
          event: 'face_service_unavailable',
          identifier: login.identifier,
          err: err.message,
          request_id: ctx.requestId,
        },
        'reconnaissance faciale indisponible',
      );
      throw new HttpError(503, 'Reconnaissance faciale indisponible', 'réessayez dans un instant', {
        reason: 'face_service_unavailable',
      });
    }
  }

  await sleep(Math.max(0, config.FACE_MIN_DELAY_MS - (Date.now() - startedAt)));

  if (result.match) {
    await transition(login, 'IDENTIFIED', {
      state: 'PASSWORD_PENDING',
      faceDistance: result.distance ?? null,
    });
    backofficeLogins.inc({ result: 'face_ok' });
    logger.info(
      {
        event: 'backoffice_face_result',
        identifier: login.identifier,
        ip: ctx.ip,
        matched: true,
        distance: result.distance ?? null,
        login_id: login.id,
        request_id: ctx.requestId,
      },
      'visage reconnu',
    );

    void LedServices.set('green-blink', {
      holdSeconds: Math.max(1, (login.expiresAt.getTime() - Date.now()) / 1000),
      reason: 'visage reconnu',
    });
    return load(id);
  }

  await transition(login, 'IDENTIFIED', {
    state: 'FACE_REFUSED',
    faceDistance: result.distance ?? null,
    finishedAt: new Date(),
  });
  const outcome = await LockoutServices.recordFailure(
    login.identifier,
    config.FACE_REFUSED_COOLDOWN_SECONDS,
  );
  backofficeLogins.inc({ result: 'face_refused' });
  logger.warn(
    {
      event: 'backoffice_login_failed',
      stage: 'face',
      reason: 'face_not_recognized',
      identifier: login.identifier,
      ip: ctx.ip,
      distance: result.distance ?? null,
      locked: outcome.locked,
      lock_level: outcome.level,
      login_id: login.id,
      request_id: ctx.requestId,
    },
    'visage non reconnu',
  );
  void LedServices.set('red-solid', {
    holdSeconds: config.LED_RED_SOLID_SECONDS,
    reason: 'visage non reconnu',
  });
  throw refused('Visage non reconnu', 'face_not_recognized', outcome);
}

// 3

export async function submitPassword(
  id: string,
  password: string,
  ctx: RequestContext,
): Promise<TokenResponse & { state: 'GRANTED' }> {
  const login = await load(id);
  if (login.state !== 'PASSWORD_PENDING') {
    throw HttpError.conflict(
      login.state === 'IDENTIFIED'
        ? 'le visage doit être vérifié avant le mot de passe'
        : 'cette connexion est terminée',
    );
  }

  const user = login.userId ? await eligibleUser(login.identifier) : null;
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !valid) {
    await transition(login, 'PASSWORD_PENDING', {
      state: 'PASSWORD_REFUSED',
      finishedAt: new Date(),
    });
    const outcome = await LockoutServices.recordFailure(
      login.identifier,
      config.PASSWORD_REFUSED_COOLDOWN_SECONDS,
    );
    backofficeLogins.inc({ result: 'password_refused' });
    logger.warn(
      {
        event: 'backoffice_login_failed',
        stage: 'password',
        reason: 'wrong_password',
        identifier: login.identifier,
        ip: ctx.ip,
        locked: outcome.locked,
        lock_level: outcome.level,
        login_id: login.id,
        request_id: ctx.requestId,
      },
      'mot de passe refusé',
    );
    void LedServices.set('red-blink', {
      holdSeconds: config.LED_RED_BLINK_SECONDS,
      reason: 'mot de passe refusé',
    });
    throw refused('Mot de passe incorrect', 'wrong_password', outcome);
  }

  await transition(login, 'PASSWORD_PENDING', { state: 'GRANTED', finishedAt: new Date() });
  await LockoutServices.recordSuccess(login.identifier);
  backofficeLogins.inc({ result: 'granted' });
  logger.info(
    {
      event: 'backoffice_login_succeeded',
      identifier: login.identifier,
      user_id: user.id,
      ip: ctx.ip,
      login_id: login.id,
      request_id: ctx.requestId,
    },
    'connexion du back-office réussie',
  );
  void LedServices.set('green-solid', {
    holdSeconds: config.LED_GREEN_SOLID_SECONDS,
    reason: 'connexion réussie',
  });

  const token = await signer.sign(user.id, validRoles(user.roles), { amr: ['face', 'pwd'] });
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: signer.ttlSeconds,
    state: 'GRANTED',
  };
}

/** Clôture les tentatives abandonnées (sans les compter comme des échecs). */
export const expireStale = () =>
  prisma.backofficeLogin.updateMany({
    where: { state: { in: ['IDENTIFIED', 'PASSWORD_PENDING'] }, expiresAt: { lt: new Date() } },
    data: { state: 'EXPIRED', finishedAt: new Date() },
  });
