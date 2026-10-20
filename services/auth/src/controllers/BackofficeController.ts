import type { Request, Response } from 'express';
import { HttpError } from '@resilience/shared';
import { requestContext } from '../lib/context.js';
import {
  LoginIdParamSchema,
  PasswordSchema,
  StartLoginSchema,
} from '../schemas/backoffice.schema.js';
import * as BackofficeServices from '../services/BackofficeServices.js';
import type { BackofficeLogin } from '../generated/prisma/client.js';

const dto = (login: BackofficeLogin) => ({
  session_id: login.id,
  state: login.state,
  expires_at: login.expiresAt.toISOString(),
});

const SIGNATURES: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

export const start = async (req: Request, res: Response) => {
  const { identifier } = StartLoginSchema.parse(req.body);
  res.status(201).json(dto(await BackofficeServices.start(identifier, requestContext(req))));
};

export const show = async (req: Request, res: Response) => {
  const { id } = LoginIdParamSchema.parse(req.params);
  res.json(dto(await BackofficeServices.get(id)));
};

export const face = async (req: Request, res: Response) => {
  const { id } = LoginIdParamSchema.parse(req.params);
  const contentType = req.header('content-type')?.split(';')[0]?.trim() ?? '';
  const signature = SIGNATURES[contentType];
  if (!signature)
    throw new HttpError(415, 'Format non pris en charge', 'envoyez une photo JPEG ou PNG');

  const image = req.body;
  if (!Buffer.isBuffer(image) || image.length === 0) throw HttpError.badRequest('photo manquante');
  if (!signature.every((byte, i) => image[i] === byte)) {
    throw new HttpError(422, 'Photo invalide', 'le contenu ne correspond pas au format annoncé');
  }
  res.json(dto(await BackofficeServices.submitFace(id, image, requestContext(req))));
};

export const password = async (req: Request, res: Response) => {
  const { id } = LoginIdParamSchema.parse(req.params);
  const { password } = PasswordSchema.parse(req.body);
  res.json(await BackofficeServices.submitPassword(id, password, requestContext(req)));
};
