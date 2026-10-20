import app from './app.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import * as BlocksServices from './services/BlocksServices.js';
import * as EngineServices from './services/EngineServices.js';

// Au démarrage : republier la liste de blocage depuis la base, puis reprendre les incidents en cours.
await BlocksServices.syncWaf().catch((err) =>
  logger.error({ err }, 'publication initiale de la liste de blocage impossible'),
);
const resumed = await EngineServices.resumeInterrupted();
if (resumed > 0) logger.warn({ resumed }, 'incidents repris après redémarrage');

// Levée des blocages arrivés à échéance.
const releaser = setInterval(() => {
  BlocksServices.releaseExpired().catch((err) =>
    logger.error({ err }, 'levée des blocages en échec'),
  );
}, 10_000);

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'service remediation démarré');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'arrêt en cours');
  clearInterval(releaser);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
