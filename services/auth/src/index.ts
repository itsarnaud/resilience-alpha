import app from './app.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { publisher } from './lib/mqtt.js';
import { prisma } from './lib/prisma.js';
import * as BackofficeServices from './services/BackofficeServices.js';
import * as LedServices from './services/LedServices.js';
import * as LockoutServices from './services/LockoutServices.js';

void LedServices.reset();

const janitor = setInterval(() => {
  BackofficeServices.expireStale().catch((err) =>
    logger.error({ err }, 'clôture des connexions abandonnées en échec'),
  );
  LockoutServices.purgeStale().catch((err) =>
    logger.error({ err }, 'purge des verrouillages en échec'),
  );
}, 30_000);
janitor.unref();

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'service auth démarré');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'arrêt en cours');
  clearInterval(janitor);
  LedServices.stop();
  server.close(async () => {
    await publisher.close().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
