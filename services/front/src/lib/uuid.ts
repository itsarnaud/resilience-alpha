/**
 * Identifiant aléatoire (UUID v4).
 * `crypto.randomUUID` n'existe que dans un contexte sécurisé (HTTPS ou localhost). En démo, le front
 * est servi en HTTP sur le réseau du labo : il faut un repli, `getRandomValues` marche partout.
 */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variante RFC 4122
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
