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

/** Schedule the next run, then re-schedule after it fires (no drift accumulation). Returns ms delay. */
function scheduleNext(): number {
    const delay = msUntilNextRun();
    logger.debug(`[AnalyticsScheduler] Next run in ${Math.round(delay / 60_000)} min`);
    timeoutId = setTimeout(() => {
        runDailyMaintenance().catch((err) => logger.warn('[AnalyticsScheduler] Daily maintenance failed', err));
        scheduleNext();
    }, delay);
    return delay;
}

export function startAnalyticsScheduler(): number {
    if (timeoutId) return 0;
    const delay = scheduleNext();
    // Also run immediately at startup to catch up any missed day.
    runDailyMaintenance().catch((err) => logger.warn('[AnalyticsScheduler] Startup maintenance failed', err));
    return Math.round(delay / 60_000);
}

export function stopAnalyticsScheduler(): void {
    if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
}
