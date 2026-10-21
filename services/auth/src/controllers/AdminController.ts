import type { Request, Response } from 'express';
import { HttpError } from '@resilience/shared';
import { requestContext } from '../lib/context.js';
import {
  CreateUserSchema,
  IdentifierParamSchema,
  UpdateUserSchema,
  UserIdParamSchema,
} from '../schemas/admin.schema.js';
import * as AdminServices from '../services/AdminServices.js';

export const list = async (_req: Request, res: Response) => {
  res.json(await AdminServices.list());
};

export const create = async (req: Request, res: Response) => {
  const { email, password, roles } = CreateUserSchema.parse(req.body);
  res.status(201).json(await AdminServices.create(email, password, roles, requestContext(req)));
};

export const update = async (req: Request, res: Response) => {
  const { id } = UserIdParamSchema.parse(req.params);
  const patch = UpdateUserSchema.parse(req.body);
  res.json(await AdminServices.update(id, patch, { sub: req.auth!.sub }, requestContext(req)));
};

const SIGNATURES: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

export const enrollFace = async (req: Request, res: Response) => {
  const { id } = UserIdParamSchema.parse(req.params);
  const contentType = req.header('content-type')?.split(';')[0]?.trim() ?? '';
  const signature = SIGNATURES[contentType];
  if (!signature)
    throw new HttpError(415, 'Format non pris en charge', 'envoyez une photo JPEG ou PNG');

  const image = req.body;
  if (!Buffer.isBuffer(image) || image.length === 0) throw HttpError.badRequest('photo manquante');
  if (!signature.every((byte, i) => image[i] === byte)) {
    throw new HttpError(422, 'Photo invalide', 'le contenu ne correspond pas au format annoncé');
  }
  res.status(201).json(await AdminServices.enrollFace(id, image, requestContext(req)));
};

export const unlock = async (req: Request, res: Response) => {
  const { identifier } = IdentifierParamSchema.parse(req.params);
  await AdminServices.unlock(identifier, requestContext(req));
  res.status(204).end();
};
