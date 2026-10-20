import { loadConfig } from '@resilience/shared';
import { z } from 'zod';

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    DATABASE_URL: z.string().min(1),
    JWT_PRIVATE_KEY: z.string().optional(),
    JWT_PRIVATE_KEY_FILE: z.string().optional(),
    JWT_ISSUER: z.string().default('resilience-auth'),
    JWT_AUDIENCE: z.string().default('resilience-platform'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
    TRUST_PROXY: z.string().default('loopback,uniquelocal'),

    // --- Connexion du back-office : visage, puis mot de passe ---

    /** Durée de validité d'une tentative de connexion (identifiant saisi, caméra allumée...). */
    BACKOFFICE_SESSION_TTL_SECONDS: z.coerce.number().positive().default(120),
    /** Échecs consécutifs (visage ou mot de passe) avant verrouillage de l'identifiant. */
    BACKOFFICE_MAX_FAILURES: z.coerce.number().int().positive().default(2),
    /** Premier verrouillage ; la durée double à chaque verrouillage successif, jusqu'au plafond. */
    BACKOFFICE_LOCK_SECONDS: z.coerce.number().positive().default(300),
    BACKOFFICE_LOCK_MAX_SECONDS: z.coerce.number().positive().default(3600),
    /** Sans nouvel échec pendant ce délai après un verrouillage, le niveau repart de zéro. */
    BACKOFFICE_LOCK_RESET_SECONDS: z.coerce.number().positive().default(3600),
    /** Délai imposé avant de pouvoir ressaisir l'identifiant : visage refusé (LED rouge fixe 30 s)... */
    FACE_REFUSED_COOLDOWN_SECONDS: z.coerce.number().nonnegative().default(30),
    /** ... ou mot de passe refusé (LED rouge clignotante, 10 fois). */
    PASSWORD_REFUSED_COOLDOWN_SECONDS: z.coerce.number().nonnegative().default(6),

    /**
     * Reconnaissance faciale : `http` appelle le service dédié (IA), `stub` simule la réponse
     * (développement et tests uniquement, refusé en production).
     */
    FACE_VERIFIER: z.enum(['stub', 'http']).default('stub'),
    FACE_SERVICE_URL: z.url().default('http://face:5000'),
    FACE_SERVICE_KEY: z.string().optional(),
    FACE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    /** Résultat du simulateur : `match` (reconnu) ou `nomatch`. */
    FACE_STUB_RESULT: z.enum(['match', 'nomatch']).default('match'),
    /**
     * Durée minimale de l'étape « photo », quelle que soit l'issue. Un identifiant inconnu est refusé
     * sans appeler le service de visage : sans ce plancher, la rapidité de la réponse révélerait quels
     * comptes existent.
     */
    FACE_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(400),

    // --- LED (ESP8266) : auth publie l'état sur un broker MQTT ---

    /** Adresse du broker (par exemple `mqtt://mosquitto:1883`). Absente : la LED n'est pas pilotée. */
    MQTT_URL: z.string().url().optional(),
    MQTT_USERNAME: z.string().optional(),
    MQTT_PASSWORD: z.string().optional(),
    /** Attente maximale de la connexion au broker avant d'abandonner une publication (démarrage, reconnexion). */
    MQTT_CONNECT_WAIT_MS: z.coerce.number().int().nonnegative().default(3000),
    MQTT_LED_TOPIC: z.string().min(1).default('resilience/led'),
    /** Durées côté serveur, alignées sur celles du firmware, pour remettre la LED à `off` à l'échéance. */
    LED_GREEN_SOLID_SECONDS: z.coerce.number().positive().default(30),
    LED_RED_SOLID_SECONDS: z.coerce.number().positive().default(30),
    LED_RED_BLINK_SECONDS: z.coerce.number().positive().default(6),
  })
  .refine((c) => c.NODE_ENV !== 'production' || c.FACE_VERIFIER === 'http', {
    message:
      'FACE_VERIFIER=http est obligatoire en production (le simulateur reconnaît tout le monde)',
    path: ['FACE_VERIFIER'],
  });

export const config = loadConfig(ConfigSchema);
