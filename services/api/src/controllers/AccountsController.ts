import type { Request, Response } from 'express';
import { actorOf } from '../lib/context.js';
import { accountDto } from '../lib/dto.js';
import { AccountIdParamSchema } from '../schemas/payments.schema.js';
import * as AccountsServices from '../services/AccountsServices.js';

export const open = async (req: Request, res: Response) => {
  res.status(201).json(accountDto(await AccountsServices.open(actorOf(req))));
};

export const list = async (req: Request, res: Response) => {
  const accounts = await AccountsServices.list(actorOf(req));
  res.json(accounts.map(accountDto));
};

export const show = async (req: Request, res: Response) => {
  const { id } = AccountIdParamSchema.parse(req.params);
  res.json(accountDto(await AccountsServices.get(actorOf(req), id)));
};
