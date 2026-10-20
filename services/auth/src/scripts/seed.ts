/**
 * Données de démonstration.
 *
 *   SEED_OPERATOR_EMAIL / SEED_OPERATOR_PASSWORD   compte opérateur (dashboard)
 *   SEED_VICTIM_EMAIL / SEED_VICTIM_PASSWORD       compte visé par le brute force (mot de passe faible voulu)
 *   SEED_SVC_DETECTOR_SECRET, SEED_SVC_DASHBOARD_SECRET, SEED_SVC_REMEDIATION_SECRET   secrets des services
 *
 * Chaque bloc est ignoré si ses variables ne sont pas définies. Relançable sans risque (upsert).
 */
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';

async function upsertUser(emailVar: string, passwordVar: string, roles: string[]) {
  const email = process.env[emailVar]?.toLowerCase().trim();
  const password = process.env[passwordVar];
  if (!email || !password) {
    console.log(`- ${emailVar} / ${passwordVar} non définis : ignoré`);
    return;
  }
  const passwordHash = await hashPassword(password);
  await prisma.user.upsert({
    where: { email },
    update: { passwordHash, roles },
    create: { email, passwordHash, roles },
  });
  console.log(`+ utilisateur ${email} (${roles.join(', ')})`);
}

async function upsertClient(clientId: string, secretVar: string, roles: string[]) {
  const secret = process.env[secretVar];
  if (!secret) {
    console.log(`- ${secretVar} non défini : client ${clientId} ignoré`);
    return;
  }
  const secretHash = await hashPassword(secret);
  await prisma.serviceClient.upsert({
    where: { clientId },
    update: { secretHash, roles },
    create: { clientId, secretHash, roles },
  });
  console.log(`+ client de service ${clientId} (${roles.join(', ')})`);
}

await upsertUser('SEED_OPERATOR_EMAIL', 'SEED_OPERATOR_PASSWORD', ['operator']);
await upsertUser('SEED_VICTIM_EMAIL', 'SEED_VICTIM_PASSWORD', ['customer']);
await upsertClient('svc-detector', 'SEED_SVC_DETECTOR_SECRET', ['svc:detector']);
await upsertClient('svc-dashboard', 'SEED_SVC_DASHBOARD_SECRET', ['svc:dashboard']);
await upsertClient('svc-remediation', 'SEED_SVC_REMEDIATION_SECRET', ['svc:remediation-canary']);

await prisma.$disconnect();
