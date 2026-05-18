import type { Prisma } from '@prisma/client';
import {
    ANALYTICS_MAX_EVENTS_PER_BATCH,
    ANALYTICS_MAX_PROPS_BYTES,
    type AnalyticsClientEvent,
    type AnalyticsEventName,
    type AnalyticsPlatform
} from '@oxyfoo/whymeet-types';

import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

/**
 * Allowed event names — kept as a runtime Set here so the WS handler can
 * reject unknown names at ingestion time. Must stay in sync with the
 * `AnalyticsEventName` union exported by @oxyfoo/whymeet-types.
 */
const ALLOWED_EVENT_NAMES: ReadonlySet<AnalyticsEventName> = new Set<AnalyticsEventName>([
    'session.start',
    'session.end',
    'screen_view',
    'feature.profile.edit_started',
    'feature.profile.complete',
    'feature.match.like',
    'feature.match.pass',
    'feature.match.create',
    'feature.message.send',
    'feature.discovery.search',
    'feature.activity.create',
    'feature.activity.join',
    'onboarding.step_completed'
]);

const ALLOWED_PLATFORMS: ReadonlySet<AnalyticsPlatform> = new Set<AnalyticsPlatform>(['ios', 'android']);

interface IngestResult {
    accepted: number;
    rejected: number;
}

function isValidEvent(event: unknown): event is AnalyticsClientEvent {
    if (!event || typeof event !== 'object') return false;
    const e = event as Record<string, unknown>;
    if (typeof e.name !== 'string' || !ALLOWED_EVENT_NAMES.has(e.name as AnalyticsEventName)) return false;
    if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return false;
    if (typeof e.platform !== 'string' || !ALLOWED_PLATFORMS.has(e.platform as AnalyticsPlatform)) return false;
    if (typeof e.appVersion !== 'string' || e.appVersion.length === 0 || e.appVersion.length > 32) return false;
    if (e.props !== undefined) {
        if (typeof e.props !== 'object' || e.props === null) return false;
        // Cheap byte-size guard
        if (JSON.stringify(e.props).length > ANALYTICS_MAX_PROPS_BYTES) return false;
    }
    return true;
}

/**
 * Persist a batch of analytics events for a given device. Fire-and-forget
 * style: errors are logged as warnings but never thrown to the caller.
 *
 * Invalid events (unknown name, oversize props, etc.) are silently dropped
 * and counted as `rejected`. The whole batch is also capped at
 * `ANALYTICS_MAX_EVENTS_PER_BATCH`; anything above is dropped.
 */
export async function recordEvents(deviceId: string, batch: unknown[]): Promise<IngestResult> {
    if (!Array.isArray(batch) || batch.length === 0) {
        return { accepted: 0, rejected: 0 };
    }

    const capped = batch.slice(0, ANALYTICS_MAX_EVENTS_PER_BATCH);
    const overflow = batch.length - capped.length;

    const valid: AnalyticsClientEvent[] = [];
    let invalid = overflow;
    for (const raw of capped) {
        if (isValidEvent(raw)) {
            valid.push(raw);
        } else {
            invalid++;
        }
    }

    if (valid.length === 0) {
        return { accepted: 0, rejected: invalid };
    }

    const db = getDatabase();
    const data: Prisma.AnalyticsEventCreateManyInput[] = valid.map((e) => ({
        name: e.name,
        deviceId,
        ts: new Date(e.ts),
        platform: e.platform,
        appVersion: e.appVersion,
        props: (e.props ?? undefined) as Prisma.InputJsonValue | undefined
    }));

    try {
        await db.analyticsEvent.createMany({ data });
        return { accepted: valid.length, rejected: invalid };
    } catch (err) {
        logger.warn(`[Analytics] Failed to ingest batch (size=${valid.length}, device=${deviceId})`, err);
        return { accepted: 0, rejected: invalid + valid.length };
    }
}

/** Exposed for tests / synchronisation with the shared type union. */
export const __ALLOWED_EVENT_NAMES = ALLOWED_EVENT_NAMES;
