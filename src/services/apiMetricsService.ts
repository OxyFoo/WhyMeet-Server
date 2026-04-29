import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';
import type { Prisma } from '@prisma/client';

/**
 * Record an external API call (provider/endpoint/status/latency...) in a
 * fire-and-forget fashion. Never throws — failures are logged as warnings.
 */
export function recordApiUsage(args: {
    provider: string;
    endpoint: string;
    status: number;
    latencyMs: number;
    userId?: string | null;
    errorCode?: string | null;
    metadata?: Record<string, unknown>;
}): void {
    const db = getDatabase();
    db.apiUsageEvent
        .create({
            data: {
                provider: args.provider,
                endpoint: args.endpoint,
                status: args.status,
                latencyMs: args.latencyMs,
                userId: args.userId ?? null,
                errorCode: args.errorCode ?? null,
                metadata: (args.metadata ?? undefined) as Prisma.InputJsonValue | undefined
            }
        })
        .catch((err) => {
            logger.warn(`[ApiMetrics] Failed to write event (provider=${args.provider})`, err);
        });
}
