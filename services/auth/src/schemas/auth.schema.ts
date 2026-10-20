import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});

export const RegisterSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(12).max(256),
});

export const ClientCredentialsSchema = z.object({
  client_id: z.string().min(1).max(100),
  client_secret: z.string().min(1).max(256),
});
