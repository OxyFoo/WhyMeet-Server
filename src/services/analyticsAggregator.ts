import { ANALYTICS_RAW_RETENTION_DAYS } from '@oxyfoo/whymeet-types';

import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

interface AggRow {
    name: string;
    dimension: string;
    count: bigint;
    unique_devices: bigint;
}

/** "YYYY-MM-DD" → midnight UTC of that day. */
function startOfDayUtc(date: Date): Date {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

function endOfDayUtc(date: Date): Date {
    const d = startOfDayUtc(date);
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
}

/**
 * Aggregate raw analytics events for the given UTC day into
 * `AnalyticsDailyMetric`. Idempotent thanks to the
 * `@@unique([date, name, dimension])` constraint + upsert.
 *
 * Dimensions emitted per (name) tuple:
 *  - total                → dimension = ""
 *  - per platform         → "platform=ios" | "platform=android"
 *  - per app version      → "appVersion=<v>" (no top-N cap V1; volume expected low)
 */
export async function aggregateDay(day: Date): Promise<{ rows: number }> {
    const db = getDatabase();
    const from = startOfDayUtc(day);
    const to = endOfDayUtc(day);
    const dateOnly = from;

    // Single SQL pass producing one row per (name, dimension) triple.
    const rows = await db.$queryRaw<AggRow[]>`
        SELECT name, '' AS dimension, COUNT(*)::bigint AS count,
               COUNT(DISTINCT "deviceId")::bigint AS unique_devices
          FROM "analytics_events"
         WHERE "ts" >= ${from} AND "ts" < ${to}
         GROUP BY name
        UNION ALL
        SELECT name, ('platform=' || platform) AS dimension, COUNT(*)::bigint AS count,
               COUNT(DISTINCT "deviceId")::bigint AS unique_devices
          FROM "analytics_events"
         WHERE "ts" >= ${from} AND "ts" < ${to}
         GROUP BY name, platform
        UNION ALL
        SELECT name, ('appVersion=' || "appVersion") AS dimension, COUNT(*)::bigint AS count,
               COUNT(DISTINCT "deviceId")::bigint AS unique_devices
          FROM "analytics_events"
         WHERE "ts" >= ${from} AND "ts" < ${to}
         GROUP BY name, "appVersion"
    `;

    // Upsert each row (idempotent — re-running a day yields the same state).
    for (const row of rows) {
        const count = Number(row.count);
        const uniqueDevices = Number(row.unique_devices);
        await db.analyticsDailyMetric.upsert({
            where: {
                date_name_dimension: {
                    date: dateOnly,
                    name: row.name,
                    dimension: row.dimension
                }
            },
            update: { count, uniqueDevices },
            create: {
                date: dateOnly,
                name: row.name,
                dimension: row.dimension,
                count,
                uniqueDevices
            }
        });
    }

    return { rows: rows.length };
}

/** Aggregate "yesterday" (UTC) — the typical scheduler call. */
export async function aggregateYesterday(): Promise<{ rows: number }> {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return aggregateDay(yesterday);
}

/** Delete raw events older than the retention window. Returns deleted count. */
export async function purgeOldRawEvents(): Promise<{ deleted: number }> {
    const db = getDatabase();
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - ANALYTICS_RAW_RETENTION_DAYS);
    const { count } = await db.analyticsEvent.deleteMany({ where: { ts: { lt: cutoff } } });
    return { deleted: count };
}

/** Convenience wrapper used by the scheduler. Never throws. */
export async function runDailyMaintenance(): Promise<void> {
    try {
        const agg = await aggregateYesterday();
        const purge = await purgeOldRawEvents();
        logger.info(`[Analytics] Daily maintenance: aggregated ${agg.rows} rows, purged ${purge.deleted} raw events`);
    } catch (err) {
        logger.warn('[Analytics] Daily maintenance failed', err);
    }
}
