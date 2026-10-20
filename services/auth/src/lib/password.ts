import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { config } from './config.js';

export const hashPassword = (password: string): Promise<string> =>
  bcrypt.hash(password, config.BCRYPT_ROUNDS);

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
  bcrypt.compare(password, hash);

let dummyHash: Promise<string> | undefined;

export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}
