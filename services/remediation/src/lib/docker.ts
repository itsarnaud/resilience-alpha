import Docker from 'dockerode';
import { config } from './config.js';

/** Ce que la remédiation a le droit de faire sur les conteneurs : redémarrer, et envoyer un signal. */
export interface ContainerControl {
  restart(name: string): Promise<void>;
  signal(name: string, signal: string): Promise<void>;
}

/**
 * Accès à Docker par le proxy filtré (jamais le socket brut), limité aux conteneurs autorisés.
 * La liste est vérifiée ici, en plus du filtrage du proxy : deux barrières.
 */
export class DockerControl implements ContainerControl {
  private readonly docker: Docker;

  constructor(
    dockerHost: string,
    private readonly allowed: string[],
  ) {
    const url = new URL(dockerHost.replace(/^tcp:/, 'http:'));
    this.docker = new Docker({
      host: url.hostname,
      port: Number(url.port) || 2375,
      protocol: url.protocol === 'https:' ? 'https' : 'http',
    });
  }

  private assertAllowed(name: string) {
    if (!this.allowed.includes(name)) {
      throw new Error(`conteneur « ${name} » non autorisé (ALLOWED_CONTAINERS)`);
    }
  }

  async restart(name: string) {
    this.assertAllowed(name);
    await this.docker.getContainer(name).restart({ t: 10 });
  }

  async signal(name: string, signal: string) {
    this.assertAllowed(name);
    await this.docker.getContainer(name).kill({ signal });
  }
}

class DisabledControl implements ContainerControl {
  async restart(): Promise<void> {
    throw new Error('accès à Docker non configuré (DOCKER_HOST)');
  }
  async signal(): Promise<void> {
    throw new Error('accès à Docker non configuré (DOCKER_HOST)');
  }
}

export const containers: ContainerControl = config.DOCKER_HOST
  ? new DockerControl(config.DOCKER_HOST, config.ALLOWED_CONTAINERS)
  : new DisabledControl();
