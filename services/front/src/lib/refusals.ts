/** Motifs de refus renvoyés par l'API, traduits pour le client. */
export const REFUSALS: Record<string, string> = {
  unknown_beneficiary:
    "Ce bénéficiaire n'est pas dans votre liste. Ajoutez-le d'abord dans « Bénéficiaires ».",
  amount_over_limit:
    'Le montant dépasse le plafond autorisé pour un virement vers un bénéficiaire.',
  insufficient_funds: 'Solde insuffisant pour ce virement.',
};

export const refusalMessage = (reason: string | null | undefined): string | null =>
  reason ? (REFUSALS[reason] ?? `Virement refusé (${reason}).`) : null;
