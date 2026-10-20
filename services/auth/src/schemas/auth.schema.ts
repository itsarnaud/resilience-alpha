import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});

export const RegisterSchema = z.object({
  email: z.email().max(254),
  password: z
    .string()
    .min(12)
    // bcrypt ignore tout ce qui dépasse 72 octets
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, {
      message: 'le mot de passe ne doit pas dépasser 72 octets',
    }),
});

export const ClientCredentialsSchema = z.object({
  client_id: z.string().min(1).max(100),
  client_secret: z.string().min(1).max(256),
});
