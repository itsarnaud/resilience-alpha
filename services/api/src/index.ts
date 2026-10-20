import app from './app.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'service api démarré');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'arrêt en cours');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
