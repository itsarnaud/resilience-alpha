import { RoleSchema } from '@resilience/shared';
import { z } from 'zod';

const AssignableRoleSchema = RoleSchema.refine((r) => !r.startsWith('svc:'), {
  message: 'rôle de service non attribuable ici',
});

export const CreateUserSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(12).max(256),
  roles: z.array(AssignableRoleSchema).min(1).max(5),
});

export const UpdateUserSchema = z
  .object({
    roles: z.array(AssignableRoleSchema).min(1).max(5).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.roles !== undefined || v.active !== undefined, {
    message: 'fournir roles et/ou active',
  });

export const UserIdParamSchema = z.object({ id: z.uuid() });
export const IdentifierParamSchema = z.object({ identifier: z.string().min(1).max(254) });
