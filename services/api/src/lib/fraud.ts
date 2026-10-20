export type FraudReason = 'unknown_beneficiary' | 'amount_over_limit';

export const FRAUD_MESSAGES: Record<FraudReason, string> = {
  unknown_beneficiary: 'virement refusé : le bénéficiaire ne figure pas dans la liste du client',
  amount_over_limit: 'virement refusé : montant supérieur au plafond autorisé',
};

/**
 * Règle anti-fraude pour un virement adressé par IBAN à un compte qui n'appartient pas à
 * l'émetteur. Volontairement simple et déterministe : le jury doit pouvoir la rejouer.
 * Renvoie le motif de refus, ou `null` si le virement est autorisé.
 */
export function evaluateIbanTransfer(input: {
  amountCents: number;
  knownBeneficiary: boolean;
  limitCents: number;
}): FraudReason | null {
  if (!input.knownBeneficiary) return 'unknown_beneficiary';
  if (input.amountCents > input.limitCents) return 'amount_over_limit';
  return null;
}
