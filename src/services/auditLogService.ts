import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';
import type { Prisma } from '@prisma/client';

/**
 * Log an auditable action in a fire-and-forget fashion.
 * Never throws — failures are only logged as warnings.
 */
export function logAudit(userId: string | null, action: string, metadata?: Record<string, unknown>, ip?: string): void {
    const db = getDatabase();
    db.auditLog
        .create({
            data: {
                userId: userId ?? null,
                action,
                metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
                ip: ip ?? null
            }
        })
        .catch((err) => {
            logger.warn(`[AuditLog] Failed to write log (action=${action})`, err);
        });
}
