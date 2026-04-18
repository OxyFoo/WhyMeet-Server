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
        return false;
    }

    try {
        redis = new Redis(env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            enableOfflineQueue: false
        });
        await redis.connect();
        await redis.ping();
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
    }
}

export function isRedisAvailable(): boolean {
    return redis !== null;
}
