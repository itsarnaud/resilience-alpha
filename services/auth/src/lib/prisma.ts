import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { config } from './config.js';

// Prisma 7 se connecte via un adaptateur de pilote (`pg`), plus par un moteur intégré.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
});
