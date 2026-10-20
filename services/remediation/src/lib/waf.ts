import { mkdir, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { config } from './config.js';
import { containers } from './docker.js';

/** Ce que la remédiation demande au WAF : appliquer la liste complète des IP à bloquer. */
export interface WafAdapter {
  publish(blockedIps: string[]): Promise<void>;
}

/**
 * Écrit la liste de blocage dans un fichier que le WAF (nginx) inclut, puis lui demande de se
 * recharger. Le mécanisme réel est à confirmer avec la cyber : seule cette classe changera.
 *
 * La liste est toujours réécrite en entier (écriture atomique) à partir de la base : pas d'état
 * caché dans le fichier, et un blocage levé disparaît bien.
 */
class FileWaf implements WafAdapter {
  constructor(
    private readonly file: string,
    private readonly reloadContainer?: string,
  ) {}

  async publish(blockedIps: string[]): Promise<void> {
    // Dernière barrière avant d'écrire dans une configuration : rien d'autre qu'une IP.
    for (const ip of blockedIps) {
      if (isIP(ip) === 0) throw new Error(`refus d'écrire une valeur qui n'est pas une IP : ${ip}`);
    }
    const body = [
      '# Géré automatiquement par le moteur de remédiation. Ne pas modifier à la main.',
      ...blockedIps.map((ip) => `deny ${ip};`),
      '',
    ].join('\n');

    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, body, { mode: 0o644 });
    await rename(tmp, this.file);

    if (this.reloadContainer) await containers.signal(this.reloadContainer, 'HUP');
  }
}

export const waf: WafAdapter = new FileWaf(config.WAF_DENYLIST_FILE, config.WAF_RELOAD_CONTAINER);
