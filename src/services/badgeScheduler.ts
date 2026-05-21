/**
 * Badge scheduler (daily).
 *
 * Re-evaluates badges that depend on absolute time rather than on event-driven
 * counters — primarily `veteran` (1-year-old account). Event-driven badges
 * (hosting / participation milestones) are awarded synchronously in the
 * relevant services via `triggerBadgeRecheck`.
 *
 * Strategy
 *   - Once per day at BADGE_SCHEDULER_HOUR_UTC.
 *   - Paginated scan of `User` rows older than 1 year that do NOT already own
 *     the `veteran` badge.
 *   - For each user, run `checkAndAwardBadges` (which itself re-evaluates the
 *     full catalog and emits WS `badge-unlocked` events).
 *   - Best-effort: a per-user failure is logged but does not abort the pass.
 */

import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';
import { env } from '@/config/env';
import { checkAndAwardBadges } from '@/services/badgeService';

const ONE_YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;

let intervalId: NodeJS.Timeout | null = null;

function getMillisecondsToNextWindow(): number {
    const windowHour = env.BADGE_SCHEDULER_HOUR_UTC;
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const utcSeconds = now.getUTCSeconds();
    const utcMs = now.getUTCMilliseconds();
    const secondsElapsedThisHour = utcMinutes * 60 + utcSeconds + utcMs / 1000;

    let hoursUntilWindow: number;
    if (utcHour < windowHour) {
        hoursUntilWindow = windowHour - utcHour;
    } else {
        hoursUntilWindow = 24 - utcHour + windowHour;
    }
    return Math.max(hoursUntilWindow * 60 * 60 * 1000 - secondsElapsedThisHour * 1000, 100);
}

function scheduleNextRun(): void {
    if (!env.BADGE_SCHEDULER_ENABLED) {
        logger.debug('[BadgeScheduler] Disabled via env; not scheduling');
        return;
    }
    const msToNext = getMillisecondsToNextWindow();
    intervalId = setTimeout(() => {
        runBadgeCheckPass()
            .catch((error) => logger.error('[BadgeScheduler] pass failed', error))
            .finally(() => scheduleNextRun());
    }, msToNext);
}

export async function runBadgeCheckPass(): Promise<{ scanned: number; checked: number }> {
    const db = getDatabase();
    const cutoff = new Date(Date.now() - ONE_YEAR_MS);

    let scanned = 0;
    let checked = 0;
    let cursor: string | undefined;

    logger.info('[BadgeScheduler] Pass started');

    while (true) {
        const users: { id: string }[] = await db.user.findMany({
            where: {
                createdAt: { lte: cutoff },
                badges: { none: { badgeKey: 'veteran', earned: true } }
            },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: PAGE_SIZE,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
        });

        if (users.length === 0) break;
        scanned += users.length;

        for (const user of users) {
            try {
                await checkAndAwardBadges(user.id);
                checked += 1;
            } catch (error) {
                logger.warn(`[BadgeScheduler] check failed for user ${user.id}`, error);
            }
        }

        cursor = users[users.length - 1].id;
        if (users.length < PAGE_SIZE) break;
    }

    logger.info(`[BadgeScheduler] Pass done — scanned=${scanned} checked=${checked}`);
    return { scanned, checked };
}

/** Start the daily scheduler. Returns the UTC timestamp of the first scheduled run, or null if disabled. */
export function startBadgeScheduler(): Date | null {
    if (!env.BADGE_SCHEDULER_ENABLED) return null;
    if (intervalId) {
        logger.warn('[BadgeScheduler] Scheduler already running');
        return null;
    }
    scheduleNextRun();
    return new Date(Date.now() + getMillisecondsToNextWindow());
}

export function stopBadgeScheduler(): void {
    if (intervalId) {
        clearTimeout(intervalId);
        intervalId = null;
    }
}
