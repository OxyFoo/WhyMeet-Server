import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';
import type { Prisma } from '@prisma/client';

/**
 * Log an auditable action in a fire-and-forget fashion.
 * Never throws — failures are only logged as warnings.
 */
export function logAudit(
    userId: string | null,
    action: string,
    metadata?: Record<string, unknown>,
    options?: { ip?: string; targetActivityId?: string | null }
): void {
    const db = getDatabase();
    db.auditLog
        .create({
            data: {
                userId: userId ?? null,
                action,
                targetActivityId: options?.targetActivityId ?? null,
                metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
                ip: options?.ip ?? null
            }
        })
        .catch((err) => {
            logger.warn(`[AuditLog] Failed to write log (action=${action})`, err);
        });
}

/**
 * Build a per-field { before, after } diff for the given keys. Only keys whose
 * value differs between `before` and `after` are included.
 */
export function diffObjects<T extends Record<string, unknown>>(
    before: T,
    after: T,
    keys: readonly (keyof T)[]
): Record<string, { before: unknown; after: unknown }> {
    const out: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of keys) {
        const a = before[key];
        const b = after[key];
        const eq =
            a === b ||
            (a instanceof Date && b instanceof Date && a.getTime() === b.getTime()) ||
            JSON.stringify(a) === JSON.stringify(b);
        if (!eq) {
            out[String(key)] = {
                before: a instanceof Date ? a.toISOString() : a,
                after: b instanceof Date ? b.toISOString() : b
            };
        }
    }
    return out;
}
