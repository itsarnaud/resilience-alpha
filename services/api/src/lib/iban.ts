import { randomInt } from 'node:crypto';

export const normalizeIban = (iban: string): string => iban.replace(/\s+/g, '').toUpperCase();

export function generateIban(): string {
  let digits = '';
  for (let i = 0; i < 23; i++) digits += randomInt(0, 10);
  return `FR76${digits}`;
}
