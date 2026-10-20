import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { ledPublish } from '../lib/metrics.js';
import { publisher } from '../lib/mqtt.js';

/** Les messages que comprend le firmware de l'ESP8266 (voir iot/esp8266-led). */
export type LedState = 'off' | 'green-blink' | 'green-solid' | 'red-blink' | 'red-solid';

export interface LedSnapshot {
  state: LedState;
  since: Date;
  /** Quand la LED repassera à `off` toute seule, si une durée a été fixée. */
  until: Date | null;
}

let current: LedSnapshot = { state: 'off', since: new Date(), until: null };
// Un seul objet physique : le dernier événement l'emporte. Chaque changement invalide les
// minuteries des précédents, pour qu'une ancienne échéance n'éteigne pas un nouvel état.
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export const get = (): LedSnapshot => current;

/**
 * Change l'état de la LED et le publie sur MQTT. À appeler sans `await` depuis une requête : la
 * promesse (jamais rejetée) ne sert qu'aux tests et au démarrage. Un échec de publication est journalisé et compté,
 * mais ne casse jamais la connexion : la LED est un signal, pas une condition d'accès.
 * `holdSeconds` : remet la LED à `off` à l'échéance (le firmware fait de même de son côté).
 */
export async function set(
  state: LedState,
  options: { holdSeconds?: number; reason?: string } = {},
): Promise<void> {
  generation += 1;
  const mine = generation;
  clearTimeout(timer);

  const now = new Date();
  const until = options.holdSeconds ? new Date(now.getTime() + options.holdSeconds * 1000) : null;
  current = { state, since: now, until };
  logger.info(
    { event: 'led_state_changed', state, reason: options.reason, until },
    `LED : ${state}`,
  );

  try {
    await publisher.publish(config.MQTT_LED_TOPIC, state);
    ledPublish.inc({ result: 'ok' });
  } catch (err) {
    ledPublish.inc({ result: 'failed' });
    logger.warn(
      { event: 'led_publish_failed', state, err: err instanceof Error ? err.message : String(err) },
      "publication de l'état de la LED impossible",
    );
  }

  if (options.holdSeconds) {
    timer = setTimeout(() => {
      if (generation === mine) void set('off', { reason: 'durée écoulée' });
    }, options.holdSeconds * 1000);
    timer.unref();
  }
}

/** Au démarrage : éteindre la LED, qui pourrait être restée dans un état d'avant un redémarrage. */
export const reset = () => set('off', { reason: 'démarrage du service' });

export function stop(): void {
  clearTimeout(timer);
}
