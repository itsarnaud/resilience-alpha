import type { Request, Response } from 'express';
import { requestContext } from '../lib/context.js';
import { ClientCredentialsSchema, LoginSchema } from '../schemas/auth.schema.js';
import * as AuthServices from '../services/AuthServices.js';

export const login = async (req: Request, res: Response) => {
  const { email, password } = LoginSchema.parse(req.body);
  res.json(await AuthServices.login(email, password, requestContext(req)));
};

export const clientToken = async (req: Request, res: Response) => {
  const { client_id, client_secret } = ClientCredentialsSchema.parse(req.body);
  res.json(await AuthServices.issueClientToken(client_id, client_secret, requestContext(req)));
};
