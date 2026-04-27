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

export type NotifType = 'match' | 'like' | 'message';

interface PushPayload {
    title: string;
    body: string;
    data?: Record<string, string>;
}

const NOTIF_TYPE_TO_SETTING: Record<NotifType, string> = {
    match: 'notifNewMatch',
    like: 'notifLikes',
    message: 'notifMessages'
};

/**
 * Send push notification to an offline user's devices.
 * Skips if user is currently connected via WS or has disabled the notification type.
 */
export async function pushToUser(userId: string, payload: PushPayload, notifType?: NotifType): Promise<void> {
    if (isUserOnline(userId)) return;
    if (!ensureInitialized()) return;

    const db = getDatabase();

    // Check user notification preferences
    if (notifType) {
        const settingKey = NOTIF_TYPE_TO_SETTING[notifType];
        const settings = await db.settings.findUnique({
            where: { userId },
            select: { [settingKey]: true }
        });
        if (settings && settings[settingKey] === false) {
            logger.debug(`[Push] Skipped (${notifType} disabled) for user ${userId}`);
            return;
        }
    }

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

/**
 * Broadcast a push notification to ALL active devices (admin console only),
 * or to a targeted set of users when `userIds` is provided.
 * Returns counts of successes and failures. Use with care.
 */
export async function broadcastPush(
    payload: PushPayload & { userIds?: string[] }
): Promise<{ success: number; failure: number; total: number }> {
    if (!ensureInitialized()) return { success: 0, failure: 0, total: 0 };
    const db = getDatabase();
    const targetUserIds = payload.userIds && payload.userIds.length > 0 ? payload.userIds : undefined;
    const devices = await db.device.findMany({
        where: {
            status: 'active',
            pushToken: { not: null },
            pushProvider: 'fcm',
            ...(targetUserIds ? { userId: { in: targetUserIds } } : {})
        },
        select: { id: true, pushToken: true }
    });
    const tokens = devices.map((d) => d.pushToken).filter((t): t is string => !!t);
    if (tokens.length === 0) return { success: 0, failure: 0, total: 0 };

    // FCM multicast caps at 500 per call
    let success = 0;
    let failure = 0;
    for (let i = 0; i < tokens.length; i += 500) {
        const slice = tokens.slice(i, i + 500);
        try {
            const response = await admin.messaging().sendEachForMulticast({
                tokens: slice,
                notification: { title: payload.title, body: payload.body },
                data: payload.data,
                android: { priority: 'high' },
                apns: { payload: { aps: { sound: 'default' } } }
            });
            success += response.successCount;
            failure += response.failureCount;
        } catch (error) {
            logger.error('[Push] broadcastPush batch failed', error);
            failure += slice.length;
        }
    }
    logger.info(`[Push] Broadcast delivered: success=${success} failure=${failure} total=${tokens.length}`);
    return { success, failure, total: tokens.length };
}
