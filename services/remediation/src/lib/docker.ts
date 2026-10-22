import Docker from 'dockerode';
import { config } from './config.js';

/** Ce que la remédiation a le droit de faire sur les conteneurs : redémarrer, et envoyer un signal. */
export interface ContainerControl {
  restart(name: string): Promise<void>;
  signal(name: string, signal: string): Promise<void>;
  /** Exécute une commande dans un conteneur (ex. lancer un playbook Ansible). Renvoie la sortie. */
  exec(name: string, cmd: string[]): Promise<string>;
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

  async exec(name: string, cmd: string[]): Promise<string> {
    this.assertAllowed(name);
    const exec = await this.docker.getContainer(name).exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await exec.start({});
    const output = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    const { ExitCode } = await exec.inspect();
    if (ExitCode !== 0) {
      throw new Error(
        `« ${cmd.join(' ')} » a échoué dans ${name} (code ${ExitCode}) : ${output.trim().slice(-500)}`,
      );
    }
    return output;
  }
}

class DisabledControl implements ContainerControl {
  async restart(): Promise<void> {
    throw new Error('accès à Docker non configuré (DOCKER_HOST)');
  }
  async signal(): Promise<void> {
    throw new Error('accès à Docker non configuré (DOCKER_HOST)');
  }
  async exec(): Promise<string> {
    throw new Error('accès à Docker non configuré (DOCKER_HOST)');
  }
}

export const containers: ContainerControl = config.DOCKER_HOST
  ? new DockerControl(config.DOCKER_HOST, config.ALLOWED_CONTAINERS)
  : new DisabledControl();
