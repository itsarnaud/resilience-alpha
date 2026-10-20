import { HttpError, type Role } from '@resilience/shared';
import type { RequestContext } from '../lib/context.js';
import { logger } from '../lib/logger.js';
import { hashPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';
import { validRoles } from '../lib/roles.js';

export interface UserProfile {
  id: string;
  email?: string;
  roles: Role[];
}

export const register = async (
  rawEmail: string,
  password: string,
  ctx: RequestContext,
): Promise<UserProfile> => {
  const email = rawEmail.toLowerCase().trim();
  if (await prisma.user.findUnique({ where: { email } })) {
    throw HttpError.conflict('un compte existe déjà avec cet email');
  }
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), roles: ['customer'] },
  });
  logger.info(
    { event: 'user_registered', user_id: user.id, request_id: ctx.requestId },
    'compte créé',
  );
  return { id: user.id, email: user.email, roles: validRoles(user.roles) };
};

/** Profil du porteur d'un jeton. Un service (`svc:...`) n'a pas de compte en base. */
export const getProfile = async (subject: string, tokenRoles: Role[]): Promise<UserProfile> => {
  if (subject.startsWith('svc:')) return { id: subject, roles: tokenRoles };
  const user = await prisma.user.findUnique({ where: { id: subject } });
  if (!user) throw HttpError.notFound('compte introuvable');
  return { id: user.id, email: user.email, roles: validRoles(user.roles) };
};
