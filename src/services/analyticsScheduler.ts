import { runDailyMaintenance } from '@/services/analyticsAggregator';
import { logger } from '@/config/logger';

const TARGET_UTC_HOUR = 3;

let timeoutId: ReturnType<typeof setTimeout> | null = null;

/** Returns the exact ms until the next TARGET_UTC_HOUR:00:00 UTC. */
function msUntilNextRun(): number {
    const now = new Date();
    const next = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), TARGET_UTC_HOUR, 0, 0, 0)
    );
    if (next.getTime() <= now.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
}

/** Schedule the next run, then re-schedule after it fires (no drift accumulation). */
function scheduleNext(): void {
    const delay = msUntilNextRun();
    logger.info(`[AnalyticsScheduler] Next run scheduled in ${Math.round(delay / 60_000)} min`);
    timeoutId = setTimeout(() => {
        runDailyMaintenance().catch((err) => logger.warn('[AnalyticsScheduler] Daily maintenance failed', err));
        scheduleNext();
    }, delay);
}

export function startAnalyticsScheduler(): void {
    if (timeoutId) return;
    scheduleNext();
    // Also run immediately at startup to catch up any missed day.
    runDailyMaintenance().catch((err) => logger.warn('[AnalyticsScheduler] Startup maintenance failed', err));
}

export function stopAnalyticsScheduler(): void {
    if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
}
