import { HttpError, type Role } from '@resilience/shared';
import type { User } from '../generated/prisma/client.js';
import type { RequestContext } from '../lib/context.js';
import { NoFaceDetectedError, FaceServiceError, face } from '../lib/face.js';
import { hashPassword } from '../lib/password.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { validRoles } from '../lib/roles.js';
import * as LockoutServices from './LockoutServices.js';

export interface UserSummary {
  id: string;
  email: string;
  roles: Role[];
  active: boolean;
  created_at: string;
}

const toSummary = (u: User): UserSummary => ({
  id: u.id,
  email: u.email,
  roles: validRoles(u.roles),
  active: u.active,
  created_at: u.createdAt.toISOString(),
});

export const list = async (): Promise<UserSummary[]> =>
  (await prisma.user.findMany({ orderBy: { createdAt: 'asc' } })).map(toSummary);

export const create = async (
  rawEmail: string,
  password: string,
  roles: Role[],
  ctx: RequestContext,
): Promise<UserSummary> => {
  const email = rawEmail.toLowerCase().trim();
  if (await prisma.user.findUnique({ where: { email } })) {
    throw HttpError.conflict('un compte existe déjà avec cet email');
  }
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), roles },
  });
  logger.info(
    {
      event: 'admin_user_created',
      user_id: user.id,
      email,
      roles,
      by: ctx.requestId,
      request_id: ctx.requestId,
    },
    'compte créé par un administrateur',
  );
  return toSummary(user);
};

/** Un compte `admin` actif ne peut jamais perdre ce statut s'il est le dernier : on se couperait l'accès. */
async function assertNotLastAdmin(excludingUserId: string) {
  const remaining = await prisma.user.count({
    where: { id: { not: excludingUserId }, active: true, roles: { has: 'admin' } },
  });
  if (remaining === 0)
    throw HttpError.conflict('impossible : ce serait le dernier administrateur actif');
}

export const update = async (
  id: string,
  patch: { roles?: Role[]; active?: boolean },
  actor: { sub: string },
  ctx: RequestContext,
): Promise<UserSummary> => {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw HttpError.notFound('compte introuvable');

  const losesAdmin =
    patch.roles !== undefined && !patch.roles.includes('admin') && user.roles.includes('admin');
  const getsDeactivated = patch.active === false && user.active;
  if ((losesAdmin || getsDeactivated) && user.roles.includes('admin')) {
    await assertNotLastAdmin(id);
  }
  if (id === actor.sub && (losesAdmin || getsDeactivated)) {
    throw HttpError.forbidden('impossible de modifier vos propres habilitations');
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(patch.roles !== undefined ? { roles: patch.roles } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    },
  });
  logger.info(
    { event: 'admin_user_updated', user_id: id, patch, request_id: ctx.requestId },
    'habilitations modifiées',
  );
  return toSummary(updated);
};

/** Enregistre un échantillon de visage pour ce compte, sous la clé utilisée par la connexion (l'email). */
export const enrollFace = async (
  id: string,
  image: Buffer,
  ctx: RequestContext,
): Promise<{ samples: number }> => {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw HttpError.notFound('compte introuvable');

  try {
    const result = await face.enroll(user.email, image);
    logger.info(
      {
        event: 'admin_face_enrolled',
        user_id: id,
        samples: result.samples,
        request_id: ctx.requestId,
      },
      'visage enrôlé',
    );
    return result;
  } catch (err) {
    if (err instanceof NoFaceDetectedError) {
      throw new HttpError(
        422,
        'Aucun visage détecté',
        'reprenez la photo, visage bien visible et centré',
      );
    }
    if (err instanceof FaceServiceError) {
      throw new HttpError(503, 'Reconnaissance faciale indisponible', 'réessayez dans un instant');
    }
    throw err;
  }
};

/** Débloque un identifiant verrouillé (deux échecs de suite au back-office). */
export const unlock = async (identifier: string, ctx: RequestContext): Promise<void> => {
  await LockoutServices.clear(identifier.toLowerCase().trim());
  logger.info(
    { event: 'admin_lockout_cleared', identifier, request_id: ctx.requestId },
    'identifiant débloqué',
  );
};
