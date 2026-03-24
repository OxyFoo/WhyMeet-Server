import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

let prisma: PrismaClient | undefined;

export function getDatabase(): PrismaClient {
    if (!prisma) {
        const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
        prisma = new PrismaClient({ adapter });
    }
    return prisma;
}

export async function connectDatabase(): Promise<boolean> {
    try {
        const db = getDatabase();
        await db.$connect();
        logger.success('[Database] Connected');
        return true;
    } catch (error) {
        logger.error('[Database] Connection failed', error);
        return false;
    }
}

export async function disconnectDatabase(): Promise<void> {
    if (prisma) {
        await prisma.$disconnect();
        prisma = undefined;
        logger.info('[Database] Disconnected');
    }
}
