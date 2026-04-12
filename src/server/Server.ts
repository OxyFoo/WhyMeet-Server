import http from 'http';
import https from 'https';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { Client } from './Client';
import { routeCommand } from './Router';
import { authRouter } from './authRoutes';
import { uploadRouter } from './uploadRoutes';
import { tokenManager } from '@/services/tokenManager';
import { getDatabase } from '@/services/database';

const clients = new Map<string, Client>();

let httpServer: http.Server | https.Server;
let wss: WebSocketServer;

function createHttpServer(): http.Server | https.Server {
    const app = express();
    app.use(helmet());
    app.use(cors());
    app.use(express.json());

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', uptime: process.uptime(), clients: clients.size });
    });

    // HTTP auth routes
    app.use('/auth', authRouter);

    // HTTP upload routes
    app.use('/upload', uploadRouter);

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

    logger.info(`[Server] Client connected: ${id} (${ip}) — Total: ${clients.size}`);

    ws.on('message', async (raw: Buffer) => {
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
            logger.success(`[Server] Listening on port ${port}`);
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
