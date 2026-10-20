import type { Request, Response } from 'express';
import { requestContext } from '../lib/context.js';
import { RegisterSchema } from '../schemas/auth.schema.js';
import * as UsersServices from '../services/UsersServices.js';

export const register = async (req: Request, res: Response) => {
  const { email, password } = RegisterSchema.parse(req.body);
  res.status(201).json(await UsersServices.register(email, password, requestContext(req)));
};

export const me = async (req: Request, res: Response) => {
  const { sub, roles } = req.auth!;
  res.json(await UsersServices.getProfile(sub, roles));
};
