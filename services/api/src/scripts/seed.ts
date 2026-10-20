/**
 * Comptes du canari : deux comptes fictifs appartenant au service de remédiation (`svc-remediation`,
 * dont le `sub` est `svc:svc-remediation`). La transaction de test passe de l'un à l'autre.
 * Aucun secret. Relançable sans risque : le solde d'un compte existant n'est pas remis à zéro.
 */
import { prisma } from '../lib/prisma.js';

const OWNER = 'svc:svc-remediation';
const CANARY_BALANCE_CENTS = 100_000_000; // 1 000 000,00 EUR fictifs, pour des milliers de tests

for (const iban of ['FR7699990000000000000000001', 'FR7699990000000000000000002']) {
  const account = await prisma.account.upsert({
    where: { iban },
    update: {},
    create: { ownerId: OWNER, iban, balanceCents: CANARY_BALANCE_CENTS },
  });
  console.log(`+ compte canari ${account.iban} (${account.balanceCents} centimes)`);
}

await prisma.$disconnect();
