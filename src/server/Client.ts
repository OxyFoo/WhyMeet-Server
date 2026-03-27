import { WebSocket } from 'ws';
import { logger } from '@/config/logger';
import type { WSClientRequest, WSEnvelope, WSServerResponse, WSServerEvent } from '@whymeet/types';

export class Client {
    readonly id: string;
    readonly ws: WebSocket;
    readonly ip: string;
    readonly userId: string;
    readonly deviceId: string;

    constructor(id: string, ws: WebSocket, ip: string, userId: string, deviceId: string) {
        this.id = id;
        this.ws = ws;
        this.ip = ip;
        this.userId = userId;
        this.deviceId = deviceId;
    }

    send(data: WSServerResponse | WSServerEvent, requestId?: string): void {
        if (this.ws.readyState !== WebSocket.OPEN) return;

        const envelope: WSEnvelope = {
            id: requestId ?? crypto.randomUUID(),
            timestamp: Date.now(),
            data
        };

        this.ws.send(JSON.stringify(envelope));
    }

    close(code?: number, reason?: string): void {
        try {
            this.ws.close(code, reason);
        } catch {
            logger.warn(`[Client ${this.id}] Failed to close connection`);
        }
    }

    parseMessage(raw: string): WSEnvelope<WSClientRequest> | null {
        try {
            const envelope = JSON.parse(raw) as WSEnvelope<WSClientRequest>;
            if (!envelope.id || !envelope.data?.command) {
                return null;
            }
            return envelope;
        } catch {
            return null;
        }
    }
}
