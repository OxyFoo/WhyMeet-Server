import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';
import type { Prisma } from '@prisma/client';

/**
 * Periodic bot / suspicious activity detector.
 *
 * Computes a weighted score per user based on 5 signals; persists results to
 * the `SuspiciousActivity` table. Users falling under MIN_SCORE_KEEP are
 * removed (cleanup of false positives between runs).
 *
 * Signals & weights:
 *   A volume_actions       25  >100 likes/h OR >200 messages/h
 *   B multi_accounts_ip    30  ≥3 distinct users share an IP within 24h
 *   C young_account_volume 15  user.createdAt < 24h ago AND >50 actions
 *   D multiple_reports     20  ≥3 distinct reporters within 7d
 *   E message_pattern      10  unique ratio <0.3 OR >50% messages <5 chars
 *                              over last 100 messages
 *
 * A score ≥ 20 results in a flag being kept; below that → deletion.
 */

const SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const FIRST_RUN_DELAY_MS = 30 * 1000; // 30 seconds after boot

const SIGNAL_WEIGHTS = {
    volume_actions: 25,
    multi_accounts_ip: 30,
    young_account_volume: 15,
    multiple_reports: 20,
    message_pattern: 10
} as const;

const MIN_SCORE_KEEP = 20;

const VOLUME_LIKES_PER_HOUR = 100;
const VOLUME_MESSAGES_PER_HOUR = 200;
const IP_MIN_DISTINCT_USERS = 3;
const YOUNG_ACCOUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const YOUNG_ACCOUNT_MIN_ACTIONS = 50;
const REPORTS_MIN_DISTINCT_REPORTERS = 3;
const REPORTS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MESSAGE_PATTERN_SAMPLE = 100;
const MESSAGE_UNIQUE_RATIO_MAX = 0.3;
const MESSAGE_SHORT_LEN = 5;
const MESSAGE_SHORT_RATIO_MIN = 0.5;

type SignalKey = keyof typeof SIGNAL_WEIGHTS;
type SignalsMap = Partial<Record<SignalKey, number>>;

let intervalId: ReturnType<typeof setInterval> | null = null;
let bootTimeoutId: ReturnType<typeof setTimeout> | null = null;
let running = false;

/** Public entry: run a full scan now (idempotent). */
export async function runSuspiciousScan(): Promise<{ flagged: number; durationMs: number }> {
    if (running) {
        logger.warn('[SuspiciousScan] previous run still in progress, skipping');
        return { flagged: 0, durationMs: 0 };
    }
    running = true;
    const start = Date.now();

    try {
        const db = getDatabase();
        const now = new Date();

        const candidateIds = await collectCandidateUserIds(db, now);
        let flagged = 0;

        for (const userId of candidateIds) {
            const signals = await computeSignalsForUser(db, userId, now);
            const score = scoreSignals(signals);

            if (score >= MIN_SCORE_KEEP) {
                await upsertFlag(db, userId, score, signals, now);
                flagged += 1;
            } else {
                await deleteFlagIfExists(db, userId);
            }
        }

        // Also clean up flags whose users are no longer candidates (signals
        // expired between runs but weren't seen this pass).
        await cleanupStaleFlags(db, candidateIds);

        const durationMs = Date.now() - start;
        logger.info(`[SuspiciousScan] done flagged=${flagged} candidates=${candidateIds.size} in ${durationMs}ms`);
        return { flagged, durationMs };
    } catch (err) {
        logger.error('[SuspiciousScan] scan failed', err);
        return { flagged: 0, durationMs: Date.now() - start };
    } finally {
        running = false;
    }
}

/**
 * Build the set of userIds worth scoring this run. We collect every user
 * who appears in any signal source within its window — this is cheaper than
 * scanning all users.
 */
async function collectCandidateUserIds(db: ReturnType<typeof getDatabase>, now: Date): Promise<Set<string>> {
    const ids = new Set<string>();

    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - REPORTS_WINDOW_MS);

    // A: recent senders of messages (last hour)
    const recentMsgSenders = await db.message.findMany({
        where: { timestamp: { gte: oneHourAgo } },
        select: { senderId: true },
        distinct: ['senderId']
    });
    for (const m of recentMsgSenders) ids.add(m.senderId);

    // A: recent likes (last hour)
    const recentLikeSenders = await db.match.findMany({
        where: { matchedAt: { gte: oneHourAgo }, category: 'like' },
        select: { senderId: true },
        distinct: ['senderId']
    });
    for (const m of recentLikeSenders) ids.add(m.senderId);

    // B: users on shared IPs (last 24h) — pull all IpLogs of the window, then group.
    const ipLogs = await db.ipLog.findMany({
        where: { createdAt: { gte: oneDayAgo } },
        select: { userId: true, ip: true }
    });
    const ipUsers = new Map<string, Set<string>>();
    for (const log of ipLogs) {
        let s = ipUsers.get(log.ip);
        if (!s) {
            s = new Set();
            ipUsers.set(log.ip, s);
        }
        s.add(log.userId);
    }
    for (const users of ipUsers.values()) {
        if (users.size >= IP_MIN_DISTINCT_USERS) {
            for (const u of users) ids.add(u);
        }
    }

    // C: young accounts (< 24h)
    const youngUsers = await db.user.findMany({
        where: { createdAt: { gte: oneDayAgo }, banned: false, deleted: false },
        select: { id: true }
    });
    for (const u of youngUsers) ids.add(u.id);

    // D: reported users (last 7d)
    const recentReports = await db.report.findMany({
        where: { createdAt: { gte: sevenDaysAgo } },
        select: { reportedId: true },
        distinct: ['reportedId']
    });
    for (const r of recentReports) ids.add(r.reportedId);

    return ids;
}

async function computeSignalsForUser(
    db: ReturnType<typeof getDatabase>,
    userId: string,
    now: Date
): Promise<SignalsMap> {
    const signals: SignalsMap = {};

    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - REPORTS_WINDOW_MS);

    // Skip bots / banned / deleted: they should not be flagged repeatedly.
    const user = await db.user.findUnique({
        where: { id: userId },
        select: { createdAt: true, banned: true, deleted: true, bot: true }
    });
    if (!user || user.deleted || user.bot) return signals;

    // A: volume_actions
    const [likeCount, msgCount] = await Promise.all([
        db.match.count({ where: { senderId: userId, category: 'like', matchedAt: { gte: oneHourAgo } } }),
        db.message.count({ where: { senderId: userId, timestamp: { gte: oneHourAgo } } })
    ]);
    if (likeCount > VOLUME_LIKES_PER_HOUR || msgCount > VOLUME_MESSAGES_PER_HOUR) {
        signals.volume_actions = SIGNAL_WEIGHTS.volume_actions;
    }

    // B: multi_accounts_ip
    const userIps = await db.ipLog.findMany({
        where: { userId, createdAt: { gte: oneDayAgo } },
        select: { ip: true },
        distinct: ['ip']
    });
    if (userIps.length > 0) {
        let shared = false;
        for (const { ip } of userIps) {
            const distinctUsers = await db.ipLog.findMany({
                where: { ip, createdAt: { gte: oneDayAgo } },
                select: { userId: true },
                distinct: ['userId']
            });
            if (distinctUsers.length >= IP_MIN_DISTINCT_USERS) {
                shared = true;
                break;
            }
        }
        if (shared) signals.multi_accounts_ip = SIGNAL_WEIGHTS.multi_accounts_ip;
    }

    // C: young_account_volume
    if (user.createdAt.getTime() >= now.getTime() - YOUNG_ACCOUNT_MAX_AGE_MS) {
        const actions = likeCount + msgCount;
        if (actions > YOUNG_ACCOUNT_MIN_ACTIONS) {
            signals.young_account_volume = SIGNAL_WEIGHTS.young_account_volume;
        }
    }

    // D: multiple_reports
    const distinctReporters = await db.report.findMany({
        where: { reportedId: userId, createdAt: { gte: sevenDaysAgo } },
        select: { reporterId: true },
        distinct: ['reporterId']
    });
    if (distinctReporters.length >= REPORTS_MIN_DISTINCT_REPORTERS) {
        signals.multiple_reports = SIGNAL_WEIGHTS.multiple_reports;
    }

    // E: message_pattern (last 100 messages)
    const recentMessages = await db.message.findMany({
        where: { senderId: userId, type: 'text' },
        select: { text: true },
        orderBy: { timestamp: 'desc' },
        take: MESSAGE_PATTERN_SAMPLE
    });
    if (recentMessages.length >= 20) {
        const normalized = recentMessages.map((m) => m.text.trim().toLowerCase());
        const uniqueCount = new Set(normalized).size;
        const uniqueRatio = uniqueCount / normalized.length;
        const shortCount = normalized.filter((t) => t.length < MESSAGE_SHORT_LEN).length;
        const shortRatio = shortCount / normalized.length;
        if (uniqueRatio < MESSAGE_UNIQUE_RATIO_MAX || shortRatio > MESSAGE_SHORT_RATIO_MIN) {
            signals.message_pattern = SIGNAL_WEIGHTS.message_pattern;
        }
    }

    return signals;
}

function scoreSignals(signals: SignalsMap): number {
    let score = 0;
    for (const v of Object.values(signals)) score += v ?? 0;
    return Math.min(100, score);
}

async function upsertFlag(
    db: ReturnType<typeof getDatabase>,
    userId: string,
    score: number,
    signals: SignalsMap,
    now: Date
): Promise<void> {
    const signalsJson = signals as unknown as Prisma.InputJsonValue;
    await db.suspiciousActivity.upsert({
        where: { userId },
        update: {
            score,
            signals: signalsJson,
            lastDetectedAt: now
        },
        create: {
            userId,
            score,
            signals: signalsJson,
            firstDetectedAt: now,
            lastDetectedAt: now
        }
    });
}

async function deleteFlagIfExists(db: ReturnType<typeof getDatabase>, userId: string): Promise<void> {
    await db.suspiciousActivity.deleteMany({ where: { userId, resolvedAt: null, acknowledgedAt: null } });
}

async function cleanupStaleFlags(db: ReturnType<typeof getDatabase>, currentCandidates: Set<string>): Promise<void> {
    // Remove unacknowledged & unresolved flags whose users are no longer
    // candidates this run — their signals have aged out.
    const open = await db.suspiciousActivity.findMany({
        where: { resolvedAt: null, acknowledgedAt: null },
        select: { userId: true }
    });
    const toDelete = open.filter((r) => !currentCandidates.has(r.userId)).map((r) => r.userId);
    if (toDelete.length === 0) return;
    await db.suspiciousActivity.deleteMany({
        where: { userId: { in: toDelete }, resolvedAt: null, acknowledgedAt: null }
    });
}

// ─── Scheduler lifecycle ────────────────────────────────────────────

export function startSuspiciousActivityScheduler(): void {
    if (intervalId || bootTimeoutId) return;
    bootTimeoutId = setTimeout(() => {
        bootTimeoutId = null;
        void runSuspiciousScan();
        intervalId = setInterval(() => {
            void runSuspiciousScan();
        }, SCAN_INTERVAL_MS);
    }, FIRST_RUN_DELAY_MS);
}

export function stopSuspiciousActivityScheduler(): void {
    if (bootTimeoutId) {
        clearTimeout(bootTimeoutId);
        bootTimeoutId = null;
    }
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}
