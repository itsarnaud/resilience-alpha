import { z } from 'zod';

export const StartLoginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
});

export const PasswordSchema = z.object({
  password: z.string().min(1).max(256),
});

export const LoginIdParamSchema = z.object({ id: z.uuid() });
