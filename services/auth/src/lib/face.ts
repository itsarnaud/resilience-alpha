import { config } from './config.js';

export interface FaceResult {
  match: boolean;
  /**
   * Distance entre le visage de la photo et celui enregistré (plus elle est petite, plus ils se
   * ressemblent ; le service décide avec son propre seuil). Gardée pour l'enquête.
   */
  distance?: number;
}

/** Le service de reconnaissance faciale ne répond pas ou répond de façon inattendue. */
export class FaceServiceError extends Error {}

export interface FaceVerifier {
  /**
   * Compare la photo au visage enregistré pour cet identifiant.
   * `user` est la clé sous laquelle le visage a été enregistré (l'identifiant du compte).
   */
  verify(user: string, image: Buffer): Promise<FaceResult>;
}

/**
 * Appelle le service de reconnaissance faciale de l'IA (`ml/face`) :
 * `POST {FACE_SERVICE_URL}/recognize` avec `{ user, image }` (JPEG ou PNG en base64),
 * réponse `{ ok, recognized, distance, threshold }`.
 *
 * Un visage non reconnu, un utilisateur non enregistré ou une photo sans visage répondent tous
 * `recognized: false` avec un code 200 : ce sont des refus. Tout le reste (service arrêté, erreur
 * serveur, réponse illisible) est une panne, signalée par `FaceServiceError` : elle ne doit pas
 * verrouiller un compte.
 */
class HttpFaceVerifier implements FaceVerifier {
  async verify(user: string, image: Buffer): Promise<FaceResult> {
    let res: Response;
    try {
      res = await fetch(`${config.FACE_SERVICE_URL}/recognize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.FACE_SERVICE_KEY ? { 'X-Api-Key': config.FACE_SERVICE_KEY } : {}),
        },
        body: JSON.stringify({ user, image: image.toString('base64') }),
        signal: AbortSignal.timeout(config.FACE_TIMEOUT_MS),
      });
    } catch {
      throw new FaceServiceError('le service de reconnaissance faciale ne répond pas');
    }
    if (!res.ok) throw new FaceServiceError(`le service de reconnaissance faciale a répondu ${res.status}`);

    const body = (await res.json().catch(() => null)) as { recognized?: unknown; distance?: unknown } | null;
    if (!body || typeof body.recognized !== 'boolean') {
      throw new FaceServiceError('réponse inattendue du service de reconnaissance faciale');
    }
    return {
      match: body.recognized,
      distance: typeof body.distance === 'number' ? body.distance : undefined,
    };
  }
}

/** Simulateur pour le développement : tout le monde est reconnu, ou personne (`FACE_STUB_RESULT`). */
class StubFaceVerifier implements FaceVerifier {
  async verify(): Promise<FaceResult> {
    return config.FACE_STUB_RESULT === 'match' ? { match: true, distance: 0 } : { match: false, distance: 1 };
  }
}

export const face: FaceVerifier = config.FACE_VERIFIER === 'http' ? new HttpFaceVerifier() : new StubFaceVerifier();
