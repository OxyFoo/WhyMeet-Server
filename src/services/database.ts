import { PrismaClient } from '@prisma/client';
import { logger } from '@/config/logger';

let prisma: PrismaClient | undefined;

export function getDatabase(): PrismaClient {
    if (!prisma) {
        prisma = new PrismaClient();
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
