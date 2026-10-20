import type { Request, Response } from 'express';
import { actorOf } from '../lib/context.js';
import { beneficiaryDto } from '../lib/dto.js';
import { CreateBeneficiarySchema } from '../schemas/payments.schema.js';
import * as BeneficiariesServices from '../services/BeneficiariesServices.js';

export const create = async (req: Request, res: Response) => {
  const { iban, label } = CreateBeneficiarySchema.parse(req.body);
  res.status(201).json(beneficiaryDto(await BeneficiariesServices.add(actorOf(req), iban, label)));
};

export const list = async (req: Request, res: Response) => {
  const beneficiaries = await BeneficiariesServices.list(actorOf(req));
  res.json(beneficiaries.map(beneficiaryDto));
};
