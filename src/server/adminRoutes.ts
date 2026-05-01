import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

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
import { invalidateAllPipelineSetup } from '@/services/pipelineSetupCache';
import { getConnectedClients } from '@/server/Server';
import { getDatabase } from '@/services/database';
import { broadcastPush } from '@/services/pushService';
import { spawnBot, cleanupBots, countBots } from '@/services/stresstestService';

const FEATURE_FLAG_KEYS = ['mapbox', 'stresstest.bot_user_mixing'] as const;
const featureFlagKeySchema = z.enum(FEATURE_FLAG_KEYS);

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
            // Some flags affect cached PipelineSetup (e.g. bot/user mixing).
            // Wipe every cached setup so the next discovery query rebuilds
            // with the new flag value — otherwise users see stale results
            // for up to ~60s.
            if (parsedKey.data === 'stresstest.bot_user_mixing') {
                const wiped = await invalidateAllPipelineSetup();
                logger.info(`[AdminAPI] Pipeline setup cache invalidated (${wiped} entries)`);
            }
            res.json({ key: parsedKey.data, enabled: parsedBody.data.enabled });
        } catch (err) {
            logger.error('[AdminAPI] feature-flag set failed', err);
            res.status(500).json({ error: 'feature_flag_failed' });
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

    const resetProfileSchema = z.object({ userId: z.string().min(1) });
    router.post('/users/reset-profile', async (req, res) => {
        const parsed = resetProfileSchema.safeParse(getJson(req));
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        const db = getDatabase();
        try {
            await db.$transaction([
                db.user.update({
                    where: { id: parsed.data.userId },
                    data: { name: '', birthDate: null, gender: '', city: '' }
                }),
                db.profile.updateMany({
                    where: { userId: parsed.data.userId },
                    data: {
                        bio: '',
                        country: '',
                        region: '',
                        city: '',
                        latitude: null,
                        longitude: null,
                        intentions: []
                    }
                }),
                db.profilePhoto.deleteMany({ where: { userId: parsed.data.userId } })
            ]);
            // Kick all connections for this user to force re-sync
            for (const client of getConnectedClients().values()) {
                if (client.userId === parsed.data.userId) client.close(4002, 'Profile reset');
            }
            res.json({ ok: true });
        } catch (err) {
            logger.error('[AdminAPI] reset-profile failed', err);
            res.status(500).json({ error: 'reset_failed' });
        }
    });

    // ─── Stresstest (synthetic accounts) ──────────────────────────────
    const spawnBotSchema = z.object({
        completeProfile: z.boolean().default(true)
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

    router.post('/stresstest/cleanup', async (_req, res) => {
        try {
            const result = await cleanupBots();
            res.json(result);
        } catch (err) {
            logger.error('[AdminAPI] cleanup-bots failed', err);
            res.status(500).json({ error: 'cleanup_failed' });
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

    return router;
}
