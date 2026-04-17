import Redis from 'ioredis';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

let redis: Redis | null = null;

export function getRedis(): Redis {
    if (!redis) {
        throw new Error('[Redis] Not connected');
    }
    return redis;
}

export async function connectRedis(): Promise<boolean> {
    if (!env.REDIS_URL) {
        logger.warn('[Redis] No REDIS_URL configured — cache disabled');
        return false;
    }

    try {
        redis = new Redis(env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            enableOfflineQueue: false
        });
        await redis.ping();
        logger.success('[Redis] Connected');
        return true;
    } catch (error) {
        logger.warn('[Redis] Connection failed — cache disabled', error);
        redis = null;
        return false;
    }
}

export async function disconnectRedis(): Promise<void> {
    if (redis) {
        await redis.quit();
        redis = null;
        logger.info('[Redis] Disconnected');
    }
}

export function isRedisAvailable(): boolean {
    return redis !== null;
}
