import { RoleSchema, type Role } from '@resilience/shared';

/** Ne garde que les rôles connus : un rôle inconnu en base ne doit jamais finir dans un jeton. */
export function validRoles(roles: string[]): Role[] {
  return roles.filter((r): r is Role => RoleSchema.safeParse(r).success);
}
