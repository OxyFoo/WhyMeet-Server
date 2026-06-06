import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';

import { env } from '@/config/env';
import { logger, listLogFiles, readLogFile } from '@/config/logger';
import { APP_VERSION } from '@/config/version';
import { isMaintenanceMode, setMaintenanceMode } from '@/services/maintenanceService';
import {
    isFeatureEnabled,
    listFeatureFlags,
    setFeatureEnabled,
    type FeatureFlagKey
} from '@/services/featureFlagService';
import { invalidateAllPipelineSetup, invalidatePipelineSetup } from '@/services/pipelineSetupCache';
import { invalidateAdsConfigCache } from '@/services/adsConfigService';
import { getConnectedClients } from '@/server/Server';
import { getDatabase } from '@/services/database';
import { broadcastPush } from '@/services/pushService';
import { processScheduledNotif } from '@/services/activityNotifScheduler';
import {
    spawnBot,
    prepareBots,
    cleanupBots,
    countBots,
    releaseBots,
    refreshBotWSTokens
} from '@/services/stresstestService';
import { runTagPromotionPass } from '@/services/tagPromotion';
import { safeDecryptText } from '@/services/messageEncryption';
import { getStorageStats } from '@/services/storageService';
import { deleteImagePair } from '@/services/photoStorageService';
import {
    invalidateActivityDiscoveryCache,
    invalidateAllActivityDiscoveryCache
} from '@/services/activityDiscoveryService';
import {
    AdminProfileResetUserNotFoundError,
    resetUserProfileToInitialState
} from '@/services/adminProfileResetService';
import { listPollsForAdmin, createPoll, updatePoll, archivePoll } from '@/services/pollService';

const FEATURE_FLAG_KEYS = [
    'mapbox',
    'stresstest.bot_user_mixing',
    'stresstest.bot_user_mixing_global',
    'notifications.disabled',
    'ads.enabled'
] as const;
const featureFlagKeySchema = z.enum(FEATURE_FLAG_KEYS);

// String-valued AppConfig keys editable via /admin/app-config/string/:key.
// Numeric quotas are edited through a different endpoint (saveUsageLimits in
// the console, which writes directly via Prisma).
const APP_CONFIG_STRING_KEYS = ['ads.interstitial.android.unit_id', 'ads.interstitial.ios.unit_id'] as const;
const appConfigStringKeySchema = z.enum(APP_CONFIG_STRING_KEYS);

// AdMob unit ID format: ca-app-pub-<publisher>/<unit>. Empty allowed (disable platform).
const AD_UNIT_ID_REGEX = /^(ca-app-pub-\d+\/\d+)?$/;

// ─── HMAC verification middleware ────────────────────────────────────

const MAX_SKEW_MS = 5 * 60 * 1000; // 5 minutes
const BODY_LIMIT = '2mb';

/**
 * Expected signature scheme (matches WhyMeet-Console/src/lib/adminApi.ts):
 *   payloadHash = sha256(rawBody) hex
 *   stringToSign = `${timestamp}.${METHOD}.${path}.${payloadHash}`
 *   signature = hex(hmacSha256(ADMIN_API_SECRET, stringToSign))
 *
 * Headers:
 *   X-Admin-Timestamp: unix millis
 *   X-Admin-Signature: hex signature
 */
function verifyHmac(req: Request, res: Response, next: NextFunction): void {
    const secret = env.ADMIN_API_SECRET;
    if (!secret || secret.length < 32) {
        res.status(503).json({ error: 'admin_api_disabled' });
        return;
    }

    const ts = req.header('x-admin-timestamp');
    const sig = req.header('x-admin-signature');
    if (!ts || !sig) {
        res.status(401).json({ error: 'missing_signature' });
        return;
    }

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > MAX_SKEW_MS) {
        res.status(401).json({ error: 'stale_timestamp' });
        return;
    }

    // req.body is a Buffer because of express.raw below; empty Buffer when no body
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const payloadHash = crypto.createHash('sha256').update(raw).digest('hex');

    // Path used in signing must be the pathname under /admin (what the console sent)
    // `req.originalUrl` includes the mount point. We use the full originalUrl minus query.
    const pathname = req.originalUrl.split('?')[0];

    const stringToSign = `${ts}.${req.method.toUpperCase()}.${pathname}.${payloadHash}`;
    const expected = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(sig, 'hex');
    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
        logger.warn(`[AdminAPI] HMAC mismatch for ${req.method} ${pathname}`);
        res.status(401).json({ error: 'invalid_signature' });
        return;
    }

    // Parse JSON body if any (content-type must be application/json for POST/PATCH/PUT)
    if (raw.length > 0) {
        try {
            (req as Request & { json?: unknown }).json = JSON.parse(raw.toString('utf8'));
        } catch {
            res.status(400).json({ error: 'invalid_json' });
            return;
        }
    } else {
        (req as Request & { json?: unknown }).json = {};
    }

    next();
}

function getJson<T>(req: Request): T {
    return (req as Request & { json: T }).json;
}

// ─── Metrics ─────────────────────────────────────────────────────────

function cpuAverage() {
    const cpus = os.cpus();
    let user = 0;
    let sys = 0;
    let idle = 0;
    let nice = 0;
    let irq = 0;
    for (const c of cpus) {
        user += c.times.user;
        sys += c.times.sys;
        idle += c.times.idle;
        nice += c.times.nice;
        irq += c.times.irq;
    }
    return { user, sys, idle, nice, irq, total: user + sys + idle + nice + irq };
}

let lastCpu = cpuAverage();

function computeCpuPercent(): number {
    const now = cpuAverage();
    const totalDiff = now.total - lastCpu.total;
    const idleDiff = now.idle - lastCpu.idle;
    lastCpu = now;
    if (totalDiff <= 0) return 0;
    return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100));
}

async function readTempC(): Promise<number | null> {
    try {
        const raw = await fs.promises.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
        const n = Number(raw.trim());
        if (!Number.isFinite(n)) return null;
        return Math.round(n / 100) / 10; // milli-°C → °C with 1 decimal
    } catch {
        return null;
    }
}

async function readDiskUsage(): Promise<{ totalBytes: number; freeBytes: number } | null> {
    try {
        // Node 18.15+: fs.promises.statfs
        const p = fs.promises as unknown as {
            statfs?: (p: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
        };
        if (!p.statfs) return null;
        const s = await p.statfs('/');
        return { totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail };
    } catch {
        return null;
    }
}

// ─── Router ──────────────────────────────────────────────────────────

const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

export function createAdminRouter(): Router {
    const router = express.Router();

    // Raw body for HMAC verification — must come BEFORE any json parser.
    router.use(express.raw({ type: '*/*', limit: BODY_LIMIT }));
    router.use(adminLimiter);
    router.use(verifyHmac);

    router.get('/ping', (_req, res) => {
        res.json({ ok: true, time: Date.now(), version: APP_VERSION });
    });

    router.get('/storage/stats', async (_req, res) => {
        try {
            const stats = await getStorageStats();
            res.json(stats);
        } catch (err) {
            logger.error('[AdminAPI] Failed to fetch storage stats', err);
            res.status(500).json({ error: 'storage_stats_failed' });
        }
    });

    router.get('/metrics', async (_req, res) => {
        const mem = { total: os.totalmem(), free: os.freemem() };
        const loadavg = os.loadavg();
        const [temp, disk] = await Promise.all([readTempC(), readDiskUsage()]);
        res.json({
            cpuPercent: computeCpuPercent(),
            loadavg,
            memory: {
                totalBytes: mem.total,
                freeBytes: mem.free,
                usedPercent: ((mem.total - mem.free) / mem.total) * 100
            },
            disk: disk ?? { totalBytes: 0, freeBytes: 0 },
            tempC: temp,
            uptimeSec: process.uptime(),
            wsClients: getConnectedClients().size,
            version: APP_VERSION,
            environment: env.ENVIRONMENT,
            maintenance: isMaintenanceMode()
        });
    });

    router.get('/clients', (_req, res) => {
        const map = getConnectedClients();
        const list = Array.from(map.values()).map((c) => ({
            id: c.id,
            userId: c.userId,
            deviceId: c.deviceId,
            ip: c.ip
        }));
        res.json({ count: list.length, clients: list });
    });

    const kickSchema = z.object({
        userId: z.string().min(1),
        reason: z.string().max(200).optional(),
        // Optional WS event sent to the client BEFORE closing the socket so
        // the mobile app can react in real time (e.g. switch to SuspendedScreen).
        event: z
            .object({
                event: z.string().min(1).max(64),
                payload: z.record(z.unknown()).optional()
            })
            .optional()
    });
    router.post('/kick', (req, res) => {
        const parsed = kickSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        let kicked = 0;
        for (const client of getConnectedClients().values()) {
            if (client.userId === parsed.data.userId) {
                if (parsed.data.event) {
                    try {
                        client.send({
                            event: parsed.data.event.event,
                            payload: parsed.data.event.payload ?? {}
                        } as never);
                    } catch {
                        /* best-effort */
                    }
                }
                client.close(4001, parsed.data.reason ?? 'Kicked by admin');
                kicked++;
            }
        }
        res.json({ kicked });
    });

    router.get('/maintenance', (_req, res) => {
        res.json({ enabled: isMaintenanceMode() });
    });

    const maintenanceSchema = z.object({ enabled: z.boolean() });
    router.post('/maintenance', (req, res) => {
        const parsed = maintenanceSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        setMaintenanceMode(parsed.data.enabled);
        logger.info(`[AdminAPI] Maintenance mode set to ${parsed.data.enabled}`);
        // If enabling maintenance, kick all WS clients immediately.
        if (parsed.data.enabled) {
            for (const client of getConnectedClients().values()) {
                client.close(1001, 'Maintenance mode');
            }
        }
        res.json({ enabled: parsed.data.enabled });
    });

    // ─── Feature flags ────────────────────────────────────────────────
    router.get('/feature-flags', async (_req, res) => {
        try {
            const flags = await listFeatureFlags();
            res.json({ flags });
        } catch (err) {
            logger.error('[AdminAPI] feature-flags list failed', err);
            res.status(500).json({ error: 'feature_flags_failed' });
        }
    });

    const featureFlagBodySchema = z.object({ enabled: z.boolean() });
    router.get('/feature-flags/:key', async (req, res) => {
        const parsedKey = featureFlagKeySchema.safeParse(req.params.key);
        if (!parsedKey.success) {
            res.status(400).json({ error: 'unknown_feature_flag' });
            return;
        }
        try {
            const enabled = await isFeatureEnabled(parsedKey.data as FeatureFlagKey);
            res.json({ key: parsedKey.data, enabled });
        } catch (err) {
            logger.error('[AdminAPI] feature-flag get failed', err);
            res.status(500).json({ error: 'feature_flag_failed' });
        }
    });

    router.post('/feature-flags/:key', async (req, res) => {
        const parsedKey = featureFlagKeySchema.safeParse(req.params.key);
        if (!parsedKey.success) {
            res.status(400).json({ error: 'unknown_feature_flag' });
            return;
        }
        const parsedBody = featureFlagBodySchema.safeParse(getJson(req));
        if (!parsedBody.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        try {
            await setFeatureEnabled(parsedKey.data as FeatureFlagKey, parsedBody.data.enabled);
            logger.info(`[AdminAPI] Feature flag "${parsedKey.data}" set to ${parsedBody.data.enabled}`);
            if (
                parsedKey.data === 'stresstest.bot_user_mixing' ||
                parsedKey.data === 'stresstest.bot_user_mixing_global'
            ) {
                const wiped = await invalidateAllPipelineSetup();
                await invalidateAllActivityDiscoveryCache();
                logger.info(`[AdminAPI] Bot isolation caches invalidated (${wiped} pipeline entries)`);
            }
            if (parsedKey.data === 'ads.enabled') {
                invalidateAdsConfigCache();
            }
            res.json({ key: parsedKey.data, enabled: parsedBody.data.enabled });
        } catch (err) {
            logger.error('[AdminAPI] feature-flag set failed', err);
            res.status(500).json({ error: 'feature_flag_failed' });
        }
    });

    // ─── App config (string-valued keys) ──────────────────────────────
    router.get('/app-config/string/:key', async (req, res) => {
        const parsedKey = appConfigStringKeySchema.safeParse(req.params.key);
        if (!parsedKey.success) {
            res.status(400).json({ error: 'unknown_app_config_key' });
            return;
        }
        try {
            const row = await getDatabase().appConfig.findUnique({ where: { key: parsedKey.data } });
            res.json({ key: parsedKey.data, value: row?.valueString ?? '' });
        } catch (err) {
            logger.error('[AdminAPI] app-config string get failed', err);
            res.status(500).json({ error: 'app_config_failed' });
        }
    });

    const appConfigStringBodySchema = z.object({ value: z.string().max(200).regex(AD_UNIT_ID_REGEX) });
    router.post('/app-config/string/:key', async (req, res) => {
        const parsedKey = appConfigStringKeySchema.safeParse(req.params.key);
        if (!parsedKey.success) {
            res.status(400).json({ error: 'unknown_app_config_key' });
            return;
        }
        const parsedBody = appConfigStringBodySchema.safeParse(getJson(req));
        if (!parsedBody.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        try {
            await getDatabase().appConfig.upsert({
                where: { key: parsedKey.data },
                update: { valueString: parsedBody.data.value, valueInt: null },
                create: { key: parsedKey.data, valueString: parsedBody.data.value, valueInt: null }
            });
            invalidateAdsConfigCache();
            logger.info(`[AdminAPI] App config "${parsedKey.data}" set to "${parsedBody.data.value}"`);
            res.json({ key: parsedKey.data, value: parsedBody.data.value });
        } catch (err) {
            logger.error('[AdminAPI] app-config string set failed', err);
            res.status(500).json({ error: 'app_config_failed' });
        }
    });

    router.get('/logs', (_req, res) => {
        res.json({ files: listLogFiles() });
    });

    router.get('/logs/file', (req, res) => {
        const name = String(req.query.name ?? '');
        const tailBytes = Number(req.query.tailBytes ?? '');
        try {
            const content = readLogFile(name, {
                tailBytes: Number.isFinite(tailBytes) && tailBytes > 0 ? Math.min(tailBytes, 5_000_000) : undefined
            });
            res.json({ name, content });
        } catch (err) {
            res.status(400).json({ error: (err as Error).message });
        }
    });

    const broadcastSchema = z.object({
        title: z.string().min(1).max(100),
        body: z.string().min(1).max(500),
        data: z.record(z.string()).optional(),
        userIds: z.array(z.string().min(1)).max(10000).optional()
    });
    router.post('/broadcast', async (req, res) => {
        const parsed = broadcastSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        try {
            const result = await broadcastPush(parsed.data);
            res.json(result);
        } catch (err) {
            logger.error('[AdminAPI] broadcast failed', err);
            res.status(500).json({ error: 'broadcast_failed' });
        }
    });

    // ─── Notifications (overview + moderation) ───────────────────────
    const notificationsListSchema = z.object({
        status: z.enum(['scheduled', 'sent', 'all']).optional().default('scheduled'),
        type: z.string().min(1).max(64).optional(),
        userId: z.string().min(1).optional(),
        activityId: z.string().min(1).optional(),
        q: z.string().min(1).max(200).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50)
    });

    router.get('/notifications', async (req, res) => {
        const parsed = notificationsListSchema.safeParse(req.query);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_query' });
            return;
        }
        const { status, type, userId, activityId, q, from, to, page, pageSize } = parsed.data;
        const fromDate = from ? new Date(from) : undefined;
        const toDate = to ? new Date(to) : undefined;
        const db = getDatabase();

        try {
            // Build common predicates. `q` is a unified search that matches
            // title/body/userId/userEmail/userName/activityId — same UX as the users
            // page so the admin doesn't need separate ID filters.
            const textWhere = q
                ? {
                      OR: [
                          { title: { contains: q, mode: 'insensitive' as const } },
                          { body: { contains: q, mode: 'insensitive' as const } },
                          { userId: { equals: q } },
                          { activityId: { equals: q } },
                          { user: { email: { contains: q, mode: 'insensitive' as const } } },
                          { user: { name: { contains: q, mode: 'insensitive' as const } } }
                      ]
                  }
                : {};

            type Row = {
                id: string;
                source: 'scheduled' | 'sent';
                type: string;
                title: string;
                body: string;
                userId: string | null;
                userName: string | null;
                userEmail: string | null;
                activityId: string | null;
                activityTitle: string | null;
                scheduledAt: string | null;
                sentAt: string | null;
                createdAt: string;
                read: boolean | null;
            };

            const rows: Row[] = [];
            let total = 0;

            // Scheduled branch
            if (status === 'scheduled' || status === 'all') {
                const where: Record<string, unknown> = { sent: false };
                if (type) where.type = type;
                if (activityId) where.activityId = activityId;
                if (fromDate || toDate) {
                    where.scheduledAt = {
                        ...(fromDate ? { gte: fromDate } : {}),
                        ...(toDate ? { lte: toDate } : {})
                    };
                }
                if (userId) {
                    where.activity = { participants: { some: { userId } } };
                }

                const [scheduled, scheduledCount] = await Promise.all([
                    db.activityScheduledNotif.findMany({
                        where,
                        orderBy: { scheduledAt: 'asc' },
                        take: pageSize * 5, // pre-load some for merging when status='all'
                        include: {
                            activity: { select: { id: true, title: true } }
                        }
                    }),
                    db.activityScheduledNotif.count({ where })
                ]);

                total += scheduledCount;

                for (const s of scheduled) {
                    if (q) {
                        const ql = q.toLowerCase();
                        const title = s.activity?.title ?? '';
                        const matchesTitle = title.toLowerCase().includes(ql);
                        const matchesActivityId = s.activityId === q;
                        if (!matchesTitle && !matchesActivityId) continue;
                    }
                    rows.push({
                        id: s.id,
                        source: 'scheduled',
                        type: s.type,
                        title: s.activity?.title ?? '(activité supprimée)',
                        body: `Rappel ${s.type} pour l'activité`,
                        userId: null,
                        userName: null,
                        userEmail: null,
                        activityId: s.activityId,
                        activityTitle: s.activity?.title ?? null,
                        scheduledAt: s.scheduledAt.toISOString(),
                        sentAt: s.sentAt ? s.sentAt.toISOString() : null,
                        createdAt: s.scheduledAt.toISOString(),
                        read: null
                    });
                }
            }

            // Sent branch (DB notifications already dispatched)
            if (status === 'sent' || status === 'all') {
                const where: Record<string, unknown> = { ...textWhere };
                if (type) where.type = type;
                if (activityId) where.activityId = activityId;
                if (userId) where.userId = userId;
                if (fromDate || toDate) {
                    where.createdAt = {
                        ...(fromDate ? { gte: fromDate } : {}),
                        ...(toDate ? { lte: toDate } : {})
                    };
                }

                const [sent, sentCount] = await Promise.all([
                    db.notification.findMany({
                        where,
                        orderBy: { createdAt: 'desc' },
                        skip: status === 'sent' ? (page - 1) * pageSize : 0,
                        take: pageSize * 2,
                        include: {
                            user: { select: { id: true, name: true, email: true } }
                        }
                    }),
                    db.notification.count({ where })
                ]);

                total += sentCount;

                for (const n of sent) {
                    rows.push({
                        id: n.id,
                        source: 'sent',
                        type: n.type,
                        title: n.title,
                        body: n.body,
                        userId: n.userId,
                        userName: n.user?.name ?? null,
                        userEmail: n.user?.email ?? null,
                        activityId: n.activityId,
                        activityTitle: null,
                        scheduledAt: null,
                        sentAt: n.createdAt.toISOString(),
                        createdAt: n.createdAt.toISOString(),
                        read: n.read
                    });
                }
            }

            // Sort merged rows by date desc (scheduled first if status='scheduled', else by sent date)
            rows.sort((a, b) => {
                const da = a.source === 'scheduled' ? (a.scheduledAt ?? a.createdAt) : (a.sentAt ?? a.createdAt);
                const dbb = b.source === 'scheduled' ? (b.scheduledAt ?? b.createdAt) : (b.sentAt ?? b.createdAt);
                // For pending scheduled: ascending (soonest first). For sent/all: descending.
                if (status === 'scheduled') return da.localeCompare(dbb);
                return dbb.localeCompare(da);
            });

            // Paginate merged result
            const start = (page - 1) * pageSize;
            const items = rows.slice(start, start + pageSize);

            res.json({ items, total, page, pageSize });
        } catch (err) {
            logger.error('[AdminAPI] notifications list failed', err);
            res.status(500).json({ error: 'notifications_list_failed' });
        }
    });

    router.get('/notifications/stats', async (_req, res) => {
        const db = getDatabase();
        const now = new Date();
        const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        try {
            const [
                scheduledPending,
                sentTotal,
                sent24h,
                sent7d,
                sent30d,
                byTypeRaw,
                distinctSentTypes,
                distinctScheduledTypes
            ] = await Promise.all([
                db.activityScheduledNotif.count({ where: { sent: false } }),
                db.notification.count(),
                db.notification.count({ where: { createdAt: { gte: since24h } } }),
                db.notification.count({ where: { createdAt: { gte: since7d } } }),
                db.notification.count({ where: { createdAt: { gte: since30d } } }),
                db.notification.groupBy({
                    by: ['type'],
                    _count: { _all: true },
                    orderBy: { _count: { type: 'desc' } },
                    take: 20
                }),
                db.notification.findMany({
                    distinct: ['type'],
                    select: { type: true },
                    orderBy: { type: 'asc' }
                }),
                db.activityScheduledNotif.findMany({
                    distinct: ['type'],
                    select: { type: true },
                    orderBy: { type: 'asc' }
                })
            ]);

            const byType: Record<string, number> = {};
            for (const row of byTypeRaw) byType[row.type] = row._count._all;

            const availableTypes = Array.from(
                new Set([...distinctSentTypes.map((r) => r.type), ...distinctScheduledTypes.map((r) => r.type)])
            ).sort();

            const killSwitchEnabled = await isFeatureEnabled('notifications.disabled');

            res.json({
                scheduledPending,
                sentTotal,
                sent24h,
                sent7d,
                sent30d,
                byType,
                availableTypes,
                killSwitchEnabled
            });
        } catch (err) {
            logger.error('[AdminAPI] notifications stats failed', err);
            res.status(500).json({ error: 'notifications_stats_failed' });
        }
    });

    router.delete('/notifications/scheduled/:id', async (req, res) => {
        const id = String(req.params.id ?? '');
        if (!id) {
            res.status(400).json({ error: 'invalid_id' });
            return;
        }
        const db = getDatabase();
        try {
            const row = await db.activityScheduledNotif.findUnique({ where: { id }, select: { sent: true } });
            if (!row) {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            if (row.sent) {
                res.status(409).json({ error: 'already_sent' });
                return;
            }
            await db.activityScheduledNotif.delete({ where: { id } });
            res.json({ ok: true });
        } catch (err) {
            logger.error('[AdminAPI] notifications scheduled delete failed', err);
            res.status(500).json({ error: 'delete_failed' });
        }
    });

    router.post('/notifications/scheduled/:id/send-now', async (req, res) => {
        const id = String(req.params.id ?? '');
        if (!id) {
            res.status(400).json({ error: 'invalid_id' });
            return;
        }
        try {
            const outcome = await processScheduledNotif(id);
            if (outcome === 'not_found') {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            res.json({ outcome });
        } catch (err) {
            logger.error('[AdminAPI] notifications scheduled send-now failed', err);
            res.status(500).json({ error: 'send_now_failed' });
        }
    });

    const resetProfileSchema = z.object({ userId: z.string().min(1) });
    router.post('/users/reset-profile', async (req, res) => {
        const parsed = resetProfileSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        try {
            const result = await resetUserProfileToInitialState(parsed.data.userId);
            // Kick all connections for this user to force re-sync
            for (const client of getConnectedClients().values()) {
                if (client.userId === parsed.data.userId) client.close(4002, 'Profile reset');
            }
            res.json(result);
        } catch (err) {
            if (err instanceof AdminProfileResetUserNotFoundError) {
                res.status(404).json({ error: 'user_not_found' });
                return;
            }
            logger.error('[AdminAPI] reset-profile failed', err);
            res.status(500).json({ error: 'reset_failed' });
        }
    });

    const hardDeleteSchema = z.object({ userId: z.string().min(1) });
    router.post('/users/hard-delete', async (req, res) => {
        const parsed = hardDeleteSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        const db = getDatabase();
        try {
            // Fetch photos before deletion for S3 cleanup
            const photos = await db.profilePhoto.findMany({
                where: { userId: parsed.data.userId },
                select: { key: true, keyBlurred: true }
            });

            // Kick active WebSocket connections
            for (const client of getConnectedClients().values()) {
                if (client.userId === parsed.data.userId) client.close(4002, 'Account deleted');
            }

            // Hard delete — cascade handles all related records
            await db.user.delete({ where: { id: parsed.data.userId } });

            // Clean up S3 files (fire-and-forget)
            void Promise.allSettled(photos.map((p) => deleteImagePair(p.key, p.keyBlurred)));

            res.json({ ok: true, deletedPhotoCount: photos.length });
        } catch (err: unknown) {
            if (
                typeof err === 'object' &&
                err !== null &&
                'code' in err &&
                (err as { code: string }).code === 'P2025'
            ) {
                res.status(404).json({ error: 'user_not_found' });
                return;
            }
            logger.error('[AdminAPI] hard-delete failed', err);
            res.status(500).json({ error: 'hard_delete_failed' });
        }
    });

    // ─── Tags ─────────────────────────────────────────────────────────
    router.post('/tags/run-promotion', async (_req, res) => {
        try {
            const start = Date.now();
            const result = await runTagPromotionPass();
            const durationMs = Date.now() - start;
            const warnings = result.skipped > 0 ? ['embedding_unavailable'] : [];
            logger.info(`[AdminAPI] Manual tag promotion pass completed: ${JSON.stringify(result)} in ${durationMs}ms`);
            res.json({ ...result, durationMs, warnings });
        } catch (err) {
            logger.error('[AdminAPI] run-promotion failed', err);
            res.status(500).json({ error: 'promotion_failed' });
        }
    });

    const deleteCanonicalTagSchema = z.object({ tagId: z.string().min(1) });
    router.post('/tags/delete-canonical', async (req, res) => {
        const parsed = deleteCanonicalTagSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }

        const db = getDatabase();
        try {
            const tag = await db.tag.findUnique({
                where: { id: parsed.data.tagId },
                select: {
                    id: true,
                    label: true,
                    _count: { select: { userTags: true, aliases: true } }
                }
            });
            if (!tag) {
                res.status(404).json({ error: 'tag_not_found' });
                return;
            }

            await db.tag.delete({ where: { id: tag.id } });
            res.json({
                deleted: true,
                tagId: tag.id,
                label: tag.label,
                unlinkedUserTags: tag._count.userTags,
                deletedAliases: tag._count.aliases
            });
        } catch (err) {
            logger.error('[AdminAPI] delete-canonical failed', err);
            res.status(500).json({ error: 'delete_failed' });
        }
    });

    const deleteAliasSchema = z.object({ aliasId: z.string().min(1) });
    router.post('/tags/delete-alias', async (req, res) => {
        const parsed = deleteAliasSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }

        const db = getDatabase();
        try {
            const alias = await db.tagAlias.findUnique({
                where: { id: parsed.data.aliasId },
                select: { id: true, alias: true, tagId: true }
            });
            if (!alias) {
                res.status(404).json({ error: 'alias_not_found' });
                return;
            }

            await db.tagAlias.delete({ where: { id: alias.id } });
            res.json({ deleted: true, aliasId: alias.id, alias: alias.alias, tagId: alias.tagId });
        } catch (err) {
            logger.error('[AdminAPI] delete-alias failed', err);
            res.status(500).json({ error: 'delete_failed' });
        }
    });

    const deleteUserTagSchema = z.object({ userTagId: z.string().min(1) });
    router.post('/tags/delete-user-tag', async (req, res) => {
        const parsed = deleteUserTagSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }

        const db = getDatabase();
        try {
            const userTag = await db.userTag.findUnique({
                where: { id: parsed.data.userTagId },
                select: { id: true, userId: true, label: true, type: true, tagId: true }
            });
            if (!userTag) {
                res.status(404).json({ error: 'user_tag_not_found' });
                return;
            }

            await db.userTag.delete({ where: { id: userTag.id } });
            for (const client of getConnectedClients().values()) {
                if (client.userId === userTag.userId) client.close(4002, 'Profile tags updated');
            }
            res.json({
                deleted: true,
                userTagId: userTag.id,
                userId: userTag.userId,
                label: userTag.label,
                type: userTag.type,
                tagId: userTag.tagId
            });
        } catch (err) {
            logger.error('[AdminAPI] delete-user-tag failed', err);
            res.status(500).json({ error: 'delete_failed' });
        }
    });

    // ─── Stresstest (synthetic accounts) ──────────────────────────────
    type BotIsolationBypassRow = {
        id: string;
        userId: string;
        createdByAdminId: string | null;
        createdAt: Date;
        user: {
            id: string;
            email: string;
            name: string;
            deleted: boolean;
            banned: boolean;
            suspended: boolean;
            bot: boolean;
        };
    };

    function serializeBotIsolationBypass(row: BotIsolationBypassRow) {
        return {
            id: row.id,
            userId: row.userId,
            createdByAdminId: row.createdByAdminId,
            createdAt: row.createdAt.toISOString(),
            user: row.user
        };
    }

    const botIsolationBypassSchema = z.object({
        userIdOrEmail: z.string().trim().min(1).max(320),
        createdByAdminId: z.string().trim().min(1).max(200).optional()
    });

    router.get('/stresstest/bot-isolation-bypass', async (_req, res) => {
        try {
            const rows = await getDatabase().botIsolationBypassUser.findMany({
                orderBy: { createdAt: 'desc' },
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            name: true,
                            deleted: true,
                            banned: true,
                            suspended: true,
                            bot: true
                        }
                    }
                }
            });
            res.json({ entries: rows.map(serializeBotIsolationBypass) });
        } catch (err) {
            logger.error('[AdminAPI] bot-isolation-bypass list failed', err);
            res.status(500).json({ error: 'bot_isolation_bypass_failed' });
        }
    });

    router.post('/stresstest/bot-isolation-bypass', async (req, res) => {
        const parsed = botIsolationBypassSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }

        const db = getDatabase();
        const userIdOrEmail = parsed.data.userIdOrEmail;
        try {
            const target = await db.user.findFirst({
                where: {
                    OR: [{ id: userIdOrEmail }, { email: { equals: userIdOrEmail, mode: 'insensitive' } }]
                },
                select: {
                    id: true,
                    email: true,
                    name: true,
                    deleted: true,
                    banned: true,
                    suspended: true,
                    bot: true
                }
            });

            if (!target) {
                res.status(404).json({ error: 'user_not_found' });
                return;
            }
            if (target.deleted) {
                res.status(409).json({ error: 'user_deleted' });
                return;
            }
            if (target.bot) {
                res.status(409).json({ error: 'user_is_bot' });
                return;
            }

            const existing = await db.botIsolationBypassUser.findUnique({
                where: { userId: target.id },
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            name: true,
                            deleted: true,
                            banned: true,
                            suspended: true,
                            bot: true
                        }
                    }
                }
            });

            const row =
                existing ??
                (await db.botIsolationBypassUser.create({
                    data: { userId: target.id, createdByAdminId: parsed.data.createdByAdminId ?? null },
                    include: {
                        user: {
                            select: {
                                id: true,
                                email: true,
                                name: true,
                                deleted: true,
                                banned: true,
                                suspended: true,
                                bot: true
                            }
                        }
                    }
                }));

            await Promise.all([invalidatePipelineSetup(target.id), invalidateActivityDiscoveryCache(target.id)]);
            res.json({ entry: serializeBotIsolationBypass(row) });
        } catch (err) {
            logger.error('[AdminAPI] bot-isolation-bypass add failed', err);
            res.status(500).json({ error: 'bot_isolation_bypass_failed' });
        }
    });

    router.delete('/stresstest/bot-isolation-bypass/:userId', async (req, res) => {
        const userId = String(req.params.userId ?? '').trim();
        if (!userId) {
            res.status(400).json({ error: 'invalid_user_id' });
            return;
        }

        try {
            const row = await getDatabase().botIsolationBypassUser.findUnique({ where: { userId } });
            if (row) {
                await getDatabase().botIsolationBypassUser.delete({ where: { userId } });
            }
            await Promise.all([invalidatePipelineSetup(userId), invalidateActivityDiscoveryCache(userId)]);
            res.json({ deleted: true, userId });
        } catch (err) {
            logger.error('[AdminAPI] bot-isolation-bypass remove failed', err);
            res.status(500).json({ error: 'bot_isolation_bypass_failed' });
        }
    });

    const spawnBotSchema = z.object({
        completeProfile: z.boolean().default(true)
    });
    const prepareBotsSchema = z.object({
        count: z.number().int().min(1).max(500),
        completeProfile: z.boolean().default(true),
        excludeUserIds: z.array(z.string().min(1)).max(500).default([]),
        noReuse: z.boolean().default(false)
    });
    const releaseBotsSchema = z.object({
        userIds: z.array(z.string().min(1)).max(500)
    });
    const refreshBotTokensSchema = z.object({
        userIds: z.array(z.string().min(1)).max(500)
    });
    router.post('/stresstest/spawn-bot', async (req, res) => {
        const parsed = spawnBotSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        try {
            const bot = await spawnBot(parsed.data);
            res.json(bot);
        } catch (err) {
            logger.error('[AdminAPI] spawn-bot failed', err);
            res.status(500).json({ error: 'spawn_failed' });
        }
    });

    router.post('/stresstest/prepare-bots', async (req, res) => {
        const parsed = prepareBotsSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        try {
            const result = await prepareBots(parsed.data);
            res.json(result);
        } catch (err) {
            logger.error('[AdminAPI] prepare-bots failed', err);
            res.status(500).json({ error: 'prepare_failed' });
        }
    });

    router.post('/stresstest/cleanup', async (_req, res) => {
        try {
            const result = await cleanupBots();
            res.json(result);
        } catch (err) {
            logger.error('[AdminAPI] cleanup-bots failed', err);
            res.status(500).json({ error: 'cleanup_failed' });
        }
    });

    router.post('/stresstest/release-bots', (req, res) => {
        const parsed = releaseBotsSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        res.json(releaseBots(parsed.data.userIds));
    });

    router.post('/stresstest/refresh-ws-tokens', async (req, res) => {
        const parsed = refreshBotTokensSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        try {
            const tokens = await refreshBotWSTokens(parsed.data.userIds);
            res.json({ tokens });
        } catch (err) {
            logger.error('[AdminAPI] refresh-stress-ws-tokens failed', err);
            res.status(500).json({ error: 'refresh_failed' });
        }
    });

    router.get('/stresstest/status', async (_req, res) => {
        try {
            const total = await countBots();
            let connected = 0;
            // Count active bot WS connections by joining clients with DB.
            // For larger fleets a Redis Set would be cheaper, but at <500
            // bots a single COUNT IN (...) is fine.
            const clientsMap = getConnectedClients();
            if (clientsMap.size > 0) {
                const ids = Array.from(clientsMap.values()).map((c) => c.userId);
                const matchingBots = await getDatabase().user.findMany({
                    where: { id: { in: ids }, bot: true },
                    select: { id: true }
                });
                connected = matchingBots.length;
            }
            res.json({ totalBots: total, connectedBots: connected });
        } catch (err) {
            logger.error('[AdminAPI] stresstest-status failed', err);
            res.status(500).json({ error: 'status_failed' });
        }
    });

    // ─── Moderation: read a user's conversation messages ────────────
    // Returns the user's recent conversations with decrypted message bodies.
    // The console gates this call behind a "report or reason" check and writes
    // its own audit log entry; this endpoint just enforces hard size limits.
    const MAX_CONVERSATIONS = 50;
    const MAX_MESSAGES_PER_CONVERSATION = 200;

    // Shared per-conversation loader: decrypts messages, returns the same shape
    // both endpoints below produce. Defined as a closure so it shares the
    // request `db` instance via the outer call site.
    async function loadConversationView(db: ReturnType<typeof getDatabase>, conversationId: string) {
        const [allParticipants, messages] = await Promise.all([
            db.conversationParticipant.findMany({
                where: { conversationId },
                select: {
                    userId: true,
                    user: {
                        select: {
                            id: true,
                            name: true,
                            deleted: true,
                            banned: true,
                            suspended: true,
                            photos: {
                                orderBy: { position: 'asc' },
                                take: 1,
                                select: { key: true, keyBlurred: true }
                            }
                        }
                    }
                }
            }),
            db.message.findMany({
                where: { conversationId },
                orderBy: { timestamp: 'desc' },
                take: MAX_MESSAGES_PER_CONVERSATION
            })
        ]);
        messages.reverse();
        const lastMessageAt = messages.length > 0 ? messages[messages.length - 1].timestamp.toISOString() : null;
        return {
            conversationId,
            lastMessageAt,
            participants: allParticipants.map((p) => ({
                id: p.user.id,
                name: p.user.name,
                photoKey: p.user.photos[0]?.key ?? null,
                photoKeyBlurred: p.user.photos[0]?.keyBlurred ?? null,
                deleted: p.user.deleted ?? false,
                banned: p.user.banned ?? false,
                suspended: p.user.suspended ?? false
            })),
            messages: messages.map((m) => ({
                id: m.id,
                senderId: m.senderId,
                text: m.type === 'text' ? safeDecryptText(m.text) : '',
                type: m.type,
                timestamp: m.timestamp.toISOString()
            }))
        };
    }

    router.get('/users/:userId/messages', async (req, res) => {
        const userId = String(req.params.userId ?? '');
        if (!userId) {
            res.status(400).json({ error: 'invalid_user_id' });
            return;
        }

        const db = getDatabase();
        try {
            const participants = await db.conversationParticipant.findMany({
                where: { userId },
                select: { conversationId: true, conversation: { select: { createdAt: true } } },
                take: MAX_CONVERSATIONS * 4 // overscan; final order resolved below
            });

            // Sort by most recently created conversation first, then cap.
            participants.sort((a, b) => b.conversation.createdAt.getTime() - a.conversation.createdAt.getTime());
            const conversationIds = participants.slice(0, MAX_CONVERSATIONS).map((p) => p.conversationId);

            const conversations = await Promise.all(conversationIds.map((id) => loadConversationView(db, id)));

            // Sort: most recent activity first (fallback to original order).
            conversations.sort((a, b) => {
                const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
                const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
                return bt - at;
            });

            res.json({ conversations });
        } catch (err) {
            logger.error('[AdminAPI] user messages fetch failed', err);
            res.status(500).json({ error: 'fetch_failed' });
        }
    });

    // Activity moderation: fetch the group conversation attached to an activity
    // (if any). Same audit semantics as the user endpoint — the console gates
    // and writes the audit log.
    router.get('/activities/:activityId/messages', async (req, res) => {
        const activityId = String(req.params.activityId ?? '');
        if (!activityId) {
            res.status(400).json({ error: 'invalid_activity_id' });
            return;
        }

        const db = getDatabase();
        try {
            const activity = await db.activity.findUnique({
                where: { id: activityId },
                select: { conversationId: true }
            });

            if (!activity) {
                res.status(404).json({ error: 'activity_not_found' });
                return;
            }

            if (!activity.conversationId) {
                res.json({ conversation: null });
                return;
            }

            const conversation = await loadConversationView(db, activity.conversationId);
            res.json({ conversation });
        } catch (err) {
            logger.error('[AdminAPI] activity messages fetch failed', err);
            res.status(500).json({ error: 'fetch_failed' });
        }
    });

    // ─── Suspicious activity (bot detection) ──────────────────────

    router.get('/suspicious/count', async (_req, res) => {
        const db = getDatabase();
        try {
            const [open, acknowledged, resolved] = await Promise.all([
                db.suspiciousActivity.count({
                    where: { resolvedAt: null, acknowledgedAt: null }
                }),
                db.suspiciousActivity.count({
                    where: { resolvedAt: null, acknowledgedAt: { not: null } }
                }),
                db.suspiciousActivity.count({ where: { resolvedAt: { not: null } } })
            ]);
            res.json({ open, acknowledged, resolved });
        } catch (err) {
            logger.error('[AdminAPI] suspicious count failed', err);
            res.status(500).json({ error: 'count_failed' });
        }
    });

    router.get('/suspicious/list', async (req, res) => {
        const statusParam = String(req.query.status ?? 'open');
        const status =
            statusParam === 'open' ||
            statusParam === 'acknowledged' ||
            statusParam === 'resolved' ||
            statusParam === 'all'
                ? statusParam
                : 'open';
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const offset = Math.max(0, Number(req.query.offset) || 0);

        let where: Prisma.SuspiciousActivityWhereInput = {};
        if (status === 'open') where = { resolvedAt: null, acknowledgedAt: null };
        else if (status === 'acknowledged') where = { resolvedAt: null, acknowledgedAt: { not: null } };
        else if (status === 'resolved') where = { resolvedAt: { not: null } };

        const db = getDatabase();
        try {
            const [rows, total] = await Promise.all([
                db.suspiciousActivity.findMany({
                    where,
                    orderBy: [{ score: 'desc' }, { lastDetectedAt: 'desc' }],
                    skip: offset,
                    take: limit,
                    include: {
                        user: {
                            select: {
                                id: true,
                                email: true,
                                name: true,
                                createdAt: true,
                                banned: true,
                                suspended: true
                            }
                        }
                    }
                }),
                db.suspiciousActivity.count({ where })
            ]);

            const records = rows.map((r) => ({
                id: r.id,
                userId: r.userId,
                userEmail: r.user.email,
                userName: r.user.name,
                userCreatedAt: r.user.createdAt.toISOString(),
                userBanned: r.user.banned,
                userSuspended: r.user.suspended,
                score: r.score,
                signals: r.signals,
                firstDetectedAt: r.firstDetectedAt.toISOString(),
                lastDetectedAt: r.lastDetectedAt.toISOString(),
                acknowledgedAt: r.acknowledgedAt ? r.acknowledgedAt.toISOString() : null,
                acknowledgedByAdminId: r.acknowledgedByAdminId,
                resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
                resolvedByAdminId: r.resolvedByAdminId,
                notes: r.notes
            }));
            res.json({ records, total });
        } catch (err) {
            logger.error('[AdminAPI] suspicious list failed', err);
            res.status(500).json({ error: 'list_failed' });
        }
    });

    router.post('/suspicious/:id/acknowledge', async (req, res) => {
        const id = String(req.params.id ?? '');
        const body = getJson<{ adminId?: string; notes?: string }>(req);
        if (!id || !body.adminId) {
            res.status(400).json({ error: 'invalid_request' });
            return;
        }
        const db = getDatabase();
        try {
            const updated = await db.suspiciousActivity.update({
                where: { id },
                data: {
                    acknowledgedAt: new Date(),
                    acknowledgedByAdminId: body.adminId,
                    notes: body.notes ?? undefined
                }
            });
            res.json({ ok: true, id: updated.id });
        } catch (err) {
            if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2025') {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            logger.error('[AdminAPI] suspicious acknowledge failed', err);
            res.status(500).json({ error: 'acknowledge_failed' });
        }
    });

    router.post('/suspicious/:id/resolve', async (req, res) => {
        const id = String(req.params.id ?? '');
        const body = getJson<{ adminId?: string; notes?: string }>(req);
        if (!id || !body.adminId) {
            res.status(400).json({ error: 'invalid_request' });
            return;
        }
        const db = getDatabase();
        try {
            const updated = await db.suspiciousActivity.update({
                where: { id },
                data: {
                    resolvedAt: new Date(),
                    resolvedByAdminId: body.adminId,
                    notes: body.notes ?? undefined
                }
            });
            res.json({ ok: true, id: updated.id });
        } catch (err) {
            if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2025') {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            logger.error('[AdminAPI] suspicious resolve failed', err);
            res.status(500).json({ error: 'resolve_failed' });
        }
    });

    // ─── Polls (sondages) ─────────────────────────────────────────────
    router.get('/polls', async (req, res) => {
        const includeArchived = String(req.query.includeArchived ?? '') === 'true';
        try {
            const polls = await listPollsForAdmin(includeArchived);
            res.json({ polls });
        } catch (err) {
            logger.error('[AdminAPI] polls list failed', err);
            res.status(500).json({ error: 'polls_list_failed' });
        }
    });

    const createPollSchema = z.object({
        question: z.string().trim().min(1).max(280),
        shopVisible: z.boolean().optional()
    });
    router.post('/polls', async (req, res) => {
        const parsed = createPollSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        try {
            const poll = await createPoll(parsed.data.question, parsed.data.shopVisible ?? false);
            res.json({ poll });
        } catch (err) {
            logger.error('[AdminAPI] poll create failed', err);
            res.status(500).json({ error: 'poll_create_failed' });
        }
    });

    const updatePollSchema = z
        .object({
            question: z.string().trim().min(1).max(280).optional(),
            shopVisible: z.boolean().optional()
        })
        .refine((d) => d.question !== undefined || d.shopVisible !== undefined, { message: 'empty_update' });
    router.patch('/polls/:id', async (req, res) => {
        const id = String(req.params.id ?? '');
        if (!id) {
            res.status(400).json({ error: 'invalid_request' });
            return;
        }
        const parsed = updatePollSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        try {
            const poll = await updatePoll(id, parsed.data);
            if (!poll) {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            res.json({ poll });
        } catch (err) {
            logger.error('[AdminAPI] poll update failed', err);
            res.status(500).json({ error: 'poll_update_failed' });
        }
    });

    router.delete('/polls/:id', async (req, res) => {
        const id = String(req.params.id ?? '');
        if (!id) {
            res.status(400).json({ error: 'invalid_request' });
            return;
        }
        try {
            const poll = await archivePoll(id);
            if (!poll) {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            res.json({ poll });
        } catch (err) {
            logger.error('[AdminAPI] poll archive failed', err);
            res.status(500).json({ error: 'poll_archive_failed' });
        }
    });

    return router;
}
