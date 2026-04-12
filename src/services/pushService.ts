import admin from 'firebase-admin';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { getDatabase } from '@/services/database';
import { getConnectedClients } from '@/server/Server';

let initialized = false;

function ensureInitialized(): boolean {
    if (initialized) return true;
    if (!env.FIREBASE_SERVICE_ACCOUNT) return false;

    try {
        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        initialized = true;
        logger.info('[Push] Firebase Admin initialized');
        return true;
    } catch (error) {
        logger.warn('[Push] Failed to initialize Firebase Admin', error);
        return false;
    }
}

function isUserOnline(userId: string): boolean {
    const clients = getConnectedClients();
    for (const c of clients.values()) {
        if (c.userId === userId) return true;
    }
    return false;
}

interface PushPayload {
    title: string;
    body: string;
    data?: Record<string, string>;
}

/**
 * Send push notification to an offline user's devices.
 * Skips if user is currently connected via WS.
 */
export async function pushToUser(userId: string, payload: PushPayload): Promise<void> {
    if (isUserOnline(userId)) return;
    if (!ensureInitialized()) return;

    const db = getDatabase();

    const devices = await db.device.findMany({
        where: {
            userId,
            status: 'active',
            pushToken: { not: null },
            pushProvider: 'fcm'
        },
        select: { id: true, pushToken: true }
    });

    if (devices.length === 0) return;

    const tokens = devices.map((d) => d.pushToken).filter((t): t is string => !!t);
    if (tokens.length === 0) return;

    const message: admin.messaging.MulticastMessage = {
        tokens,
        notification: {
            title: payload.title,
            body: payload.body
        },
        data: payload.data,
        android: {
            priority: 'high'
        },
        apns: {
            payload: {
                aps: {
                    sound: 'default',
                    badge: 1
                }
            }
        }
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(message);

        // Clean up invalid tokens
        if (response.failureCount > 0) {
            const invalidTokenDeviceIds: string[] = [];
            response.responses.forEach((resp, idx) => {
                if (
                    !resp.success &&
                    resp.error &&
                    (resp.error.code === 'messaging/invalid-registration-token' ||
                        resp.error.code === 'messaging/registration-token-not-registered')
                ) {
                    const device = devices[idx];
                    if (device) invalidTokenDeviceIds.push(device.id);
                }
            });

            if (invalidTokenDeviceIds.length > 0) {
                await db.device.updateMany({
                    where: { id: { in: invalidTokenDeviceIds } },
                    data: { pushToken: null, pushProvider: null }
                });
                logger.info(`[Push] Cleaned ${invalidTokenDeviceIds.length} invalid token(s)`);
            }
        }

        logger.debug(`[Push] Sent to ${response.successCount}/${tokens.length} device(s) for user ${userId}`);
    } catch (error) {
        logger.error('[Push] Failed to send push notification', error);
    }
}
