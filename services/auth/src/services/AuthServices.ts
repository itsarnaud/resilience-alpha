import { HttpError } from '@resilience/shared';
import type { RequestContext } from '../lib/context.js';
import { logger } from '../lib/logger.js';
import { clientFailures, loginFailures, loginSuccesses } from '../lib/metrics.js';
import { getDummyHash, verifyPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';
import { signer } from '../lib/keys.js';
import { validRoles } from '../lib/roles.js';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

const toResponse = (access_token: string): TokenResponse => ({
  access_token,
  token_type: 'Bearer',
  expires_in: signer.ttlSeconds,
});

export const login = async (
  rawEmail: string,
  password: string,
  ctx: RequestContext,
): Promise<TokenResponse> => {
  const email = rawEmail.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  const valid = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

  if (!user || !valid) {
    const reason = user ? 'bad_password' : 'unknown_user';
    loginFailures.inc({ reason });
    await prisma.loginAttempt.create({
      data: { email, userId: user?.id, ip: ctx.ip, success: false, reason },
    });
    logger.warn(
      { event: 'login_failed', email, ip: ctx.ip, reason, request_id: ctx.requestId },
      'échec de connexion',
    );
    throw HttpError.unauthorized('identifiants invalides');
  }

  loginSuccesses.inc();
  await prisma.loginAttempt.create({
    data: { email, userId: user.id, ip: ctx.ip, success: true },
  });
  logger.info(
    { event: 'login_succeeded', email, user_id: user.id, ip: ctx.ip, request_id: ctx.requestId },
    'connexion réussie',
  );

  return toResponse(await signer.sign(user.id, validRoles(user.roles)));
};

/** Flux client credentials pour les services (détecteur, dashboard, remédiation). */
export const issueClientToken = async (
  clientId: string,
  secret: string,
  ctx: RequestContext,
): Promise<TokenResponse> => {
  const client = await prisma.serviceClient.findUnique({ where: { clientId } });
  const valid = await verifyPassword(secret, client?.secretHash ?? (await getDummyHash()));

  if (!client || !valid) {
    clientFailures.inc();
    logger.warn(
      { event: 'client_auth_failed', client_id: clientId, ip: ctx.ip, request_id: ctx.requestId },
      "échec d'authentification de service",
    );
    throw HttpError.unauthorized('identifiants de service invalides');
  }

  logger.info(
    { event: 'client_token_issued', client_id: clientId, request_id: ctx.requestId },
    'jeton de service émis',
  );
  return toResponse(await signer.sign(`svc:${client.clientId}`, validRoles(client.roles)));
};
