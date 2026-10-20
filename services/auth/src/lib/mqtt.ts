import mqtt, { type MqttClient } from 'mqtt';
import { config } from './config.js';
import { logger } from './logger.js';

/** Ce que le reste du service sait faire du broker : publier un message court. */
export interface Publisher {
  publish(topic: string, payload: string): Promise<void>;
  close(): Promise<void>;
}

class MqttPublisher implements Publisher {
  private readonly client: MqttClient;

  constructor(url: string) {
    this.client = mqtt.connect(url, {
      clientId: `auth-${process.pid}`,
      username: config.MQTT_USERNAME,
      password: config.MQTT_PASSWORD,
      reconnectPeriod: 2000,
      connectTimeout: 4000,
    });
    this.client.on('connect', () =>
      logger.info({ event: 'mqtt_connected' }, 'broker MQTT connecté'),
    );
    this.client.on('error', (err) =>
      logger.warn({ event: 'mqtt_error', err: err.message }, 'broker MQTT : erreur'),
    );
  }

  /** Attend la connexion un court instant : au démarrage, le client n'a pas encore fini de se connecter. */
  private waitConnected(): Promise<void> {
    if (this.client.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.client.off('connect', onConnect);
        reject(new Error('broker MQTT non connecté'));
      }, config.MQTT_CONNECT_WAIT_MS);
      this.client.once('connect', onConnect);
    });
  }

  async publish(topic: string, payload: string): Promise<void> {
    await this.waitConnected();
    // QoS 1 : le broker accuse réception. Pas de retain : rejouer un état à durée limitée
    // (vert fixe 30 s) à la reconnexion de l'ESP afficherait une LED fausse.
    await new Promise<void>((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 1, retain: false }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    await this.client.endAsync(true);
  }
}

/** Sans MQTT_URL, la LED n'est pas pilotée : chaque publication échoue (et est journalisée, sans bloquer). */
class DisabledPublisher implements Publisher {
  async publish(): Promise<void> {
    throw new Error('MQTT non configuré (MQTT_URL)');
  }
  async close(): Promise<void> {}
}

export const publisher: Publisher = config.MQTT_URL
  ? new MqttPublisher(config.MQTT_URL)
  : new DisabledPublisher();
