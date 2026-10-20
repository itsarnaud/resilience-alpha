const euros = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

/** 123456 devient « 1 234,56 € ». Les montants circulent toujours en centimes (entiers). */
export const formatEuros = (cents: number): string => euros.format(cents / 100);

/**
 * « 12,50 » ou « 12.5 » devient 1250. Calcul sur les chaînes, sans flottant (pas de 0,1 + 0,2).
 * Renvoie `null` si la saisie n'est pas un montant valide.
 */
export function eurosToCents(input: string): number | null {
  const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
