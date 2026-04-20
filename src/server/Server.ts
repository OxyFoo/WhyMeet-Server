import http from 'http';
import https from 'https';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';

import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { Client } from './Client';
import { routeCommand } from './Router';
import { authRouter } from './authRoutes';
import { uploadRouter } from './uploadRoutes';
import { tokenManager } from '@/services/tokenManager';
import { getDatabase } from '@/services/database';
import { isMaintenanceMode } from '@/services/maintenanceService';
import { renderTemplate } from '@/services/templateService';

const clients = new Map<string, Client>();

let httpServer: http.Server | https.Server;
let wss: WebSocketServer;

// ─── Rate limiting ──────────────────────────────────────────────────

const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

const healthLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

// WS: 60 messages/min per client, disconnect if 3× the limit (180/min)
const WS_RATE_WINDOW_MS = 60_000;
const WS_RATE_LIMIT = 60;
const WS_RATE_DISCONNECT_THRESHOLD = 180;

function createHttpServer(): http.Server | https.Server {
    const app = express();
    app.use(helmet());
    app.use(cors());
    app.use(express.json());

    // Global rate limit (per IP)
    app.use(globalLimiter);

    app.get('/health', healthLimiter, (_req, res) => {
        const maintenance = isMaintenanceMode();
        res.json({
            status: maintenance ? 'maintenance' : 'ok',
            uptime: process.uptime(),
            clients: clients.size
        });
    });

    // Maintenance mode middleware (blocks all routes except /health)
    app.use((req, res, next) => {
        if (isMaintenanceMode()) {
            const accept = req.headers.accept ?? '';
            if (accept.includes('text/html')) {
                const html = renderTemplate('status-page.html', {
                    title: 'Maintenance',
                    message: "WhyMeet is under maintenance. We'll be back shortly.",
                    icon: '🔧'
                });
                res.status(503).type('html').send(html);
            } else {
                res.status(503).json({ error: 'maintenance' });
            }
            return;
        }
        next();
    });

    // HTTP auth routes
    app.use('/auth', authRouter);

    // HTTP upload routes
    app.use('/upload', uploadLimiter, uploadRouter);

    if (env.SSL_PRIVATE_KEY_PATH && env.SSL_CERTIFICATE_PATH) {
        try {
            const key = fs.readFileSync(env.SSL_PRIVATE_KEY_PATH);
            const cert = fs.readFileSync(env.SSL_CERTIFICATE_PATH);
            logger.info('[Server] SSL enabled');
            return https.createServer({ key, cert }, app);
        } catch (error) {
            logger.warn('[Server] Failed to load SSL certs, falling back to HTTP', error);
        }
    }

    return http.createServer(app);
}

function getClientIp(req: http.IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
}

function onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const id = crypto.randomUUID();
    const ip = getClientIp(req);

    // Extract userId and deviceId from verified WS token (set during verifyClient)
    const userId = (req as unknown as { wsUserId: string }).wsUserId;
    const deviceId = (req as unknown as { wsDeviceId: string }).wsDeviceId;

    const client = new Client(id, ws, ip, userId, deviceId);
    clients.set(id, client);

    // Log IP asynchronously (non-blocking)
    const db = getDatabase();
    db.ipLog.create({ data: { ip, userId, deviceId } }).catch((err) => logger.warn('[Server] Failed to log IP', err));
    db.device
        .update({ where: { id: deviceId }, data: { lastIp: ip, lastSeenAt: new Date() } })
        .catch((err) => logger.warn('[Server] Failed to update device IP', err));

    logger.info(`[Server] Client connected: ${id} (${ip}) — Total: ${clients.size}`);

    ws.on('message', async (raw: Buffer) => {
        // ── WS rate limiting ──
        const now = Date.now();
        if (now - client.messageWindowStart > WS_RATE_WINDOW_MS) {
            client.messageCount = 0;
            client.messageWindowStart = now;
            client.rateLimitWarnings = 0;
        }
        client.messageCount++;

        if (client.messageCount > WS_RATE_DISCONNECT_THRESHOLD) {
            logger.warn(
                `[Server] Client ${id} exceeded WS abuse threshold (${client.messageCount} msgs), disconnecting`
            );
            client.close(4029, 'Rate limit exceeded');
            return;
        }

        if (client.messageCount > WS_RATE_LIMIT) {
            client.rateLimitWarnings++;
            if (client.rateLimitWarnings <= 1) {
                client.send({ event: 'rate-limited', payload: { message: 'Too many requests, slow down' } });
            }
            return;
        }

        const envelope = client.parseMessage(raw.toString());
        if (!envelope) {
            logger.warn(`[Server] Invalid message from ${id}`);
            return;
        }

        const response = await routeCommand(client, envelope.data);
        if (response) {
            client.send(response, envelope.id);
        }
    });

    ws.on('close', () => {
        clients.delete(id);
        logger.info(`[Server] Client disconnected: ${id} — Total: ${clients.size}`);
    });

    ws.on('error', (error) => {
        logger.error(`[Server] Client error: ${id}`, error);
        clients.delete(id);
    });
}

export function startServer(port: number): Promise<void> {
    return new Promise((resolve) => {
        httpServer = createHttpServer();
        wss = new WebSocketServer({
            server: httpServer,
            verifyClient: async (info, callback) => {
                try {
                    // Reject all WS connections during maintenance
                    if (isMaintenanceMode()) {
                        callback(false, 503, 'Server under maintenance');
                        return;
                    }

                    const url = new URL(info.req.url ?? '', `http://${info.req.headers.host}`);
                    const token = url.searchParams.get('token');

                    if (!token) {
                        callback(false, 401, 'Missing token');
                        return;
                    }

                    const payload = tokenManager.ws.verify(token);
                    if (!payload) {
                        callback(false, 401, 'Invalid or expired token');
                        return;
                    }

                    // Double-check in DB: device must be active and belong to the claimed user
                    const db = getDatabase();
                    const device = await db.device.findUnique({ where: { id: payload.deviceId } });
                    if (!device || device.status !== 'active' || device.userId !== payload.userId) {
                        callback(false, 401, 'Device revoked or invalid');
                        return;
                    }

                    // Check if the user is banned, suspended, or deleted
                    const user = await db.user.findUnique({
                        where: { id: payload.userId },
                        select: { banned: true, suspended: true, deleted: true }
                    });
                    if (user?.banned) {
                        callback(false, 4003, 'Account banned');
                        return;
                    }
                    if (user?.suspended) {
                        callback(false, 4003, 'Account suspended');
                        return;
                    }
                    if (user?.deleted) {
                        callback(false, 4003, 'Account deleted');
                        return;
                    }

                    // Check if this IP is associated with a banned user
                    const clientIp = getClientIp(info.req);
                    const bannedIpLog = await db.ipLog.findFirst({
                        where: { ip: clientIp, user: { banned: true } }
                    });
                    if (bannedIpLog) {
                        logger.warn(`[Server] Blocked connection from banned IP ${clientIp} (user ${payload.userId})`);
                        callback(false, 4003, 'IP banned');
                        return;
                    }

                    // Attach userId/deviceId to the request for onConnection
                    (info.req as unknown as { wsUserId: string }).wsUserId = payload.userId;
                    (info.req as unknown as { wsDeviceId: string }).wsDeviceId = payload.deviceId;
                    callback(true);
                } catch (error) {
                    logger.error('[Server] verifyClient error', error);
                    callback(false, 500, 'Internal error');
                }
            }
        });

        wss.on('connection', onConnection);

        httpServer.listen(port, () => {
            resolve();
        });
    });
}

export async function stopServer(): Promise<void> {
    for (const client of clients.values()) {
        client.close(1001, 'Server shutting down');
    }
    clients.clear();

    if (wss) {
        wss.close();
    }

    return new Promise((resolve) => {
        if (httpServer) {
            httpServer.close(() => {
                logger.info('[Server] HTTP server closed');
                resolve();
            });
        } else {
            resolve();
        }
    });
}

export function getConnectedClients(): Map<string, Client> {
    return clients;
}
