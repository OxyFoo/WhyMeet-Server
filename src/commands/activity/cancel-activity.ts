import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_CancelActivity, WSResponse_CancelActivity } from '@oxyfoo/whymeet-types';
import { cancelActivity } from '@/services/activityService';
import { getDatabase } from '@/services/database';
import { getConnectedClients } from '@/server/Server';
import { pushToUser } from '@/services/pushService';
import { t, getUserLanguage } from '@/services/notifI18n';
import { logger } from '@/config/logger';

registerCommand<WSRequest_CancelActivity>(
    'cancel-activity',
    async (client: Client, payload): Promise<WSResponse_CancelActivity> => {
        try {
            const { activityId } = payload;
            const db = getDatabase();

            // Get activity info before cancellation for notifications
            const activity = await db.activity.findUnique({
                where: { id: activityId },
                include: { participants: { select: { userId: true } } }
            });

            const success = await cancelActivity(activityId, client.userId);
            if (!success) {
                return { command: 'cancel-activity', payload: { error: 'Activity not found or not the host' } };
            }

            // Notify all participants (except host)
            if (activity) {
                const connectedClients = getConnectedClients();
                for (const p of activity.participants) {
                    if (p.userId === client.userId) continue;

                    const lang = await getUserLanguage(p.userId);
                    const title = t(lang, 'activity_cancelled_title', { title: activity.title });
                    const body = t(lang, 'activity_cancelled_body', { title: activity.title });

                    const notif = await db.notification.create({
                        data: {
                            userId: p.userId,
                            type: 'system',
                            title,
                            body,
                            activityId
                        }
                    });

                    let isOnline = false;
                    for (const c of connectedClients.values()) {
                        if (c.userId === p.userId) {
                            c.send({
                                event: 'notification',
                                payload: {
                                    notification: {
                                        id: notif.id,
                                        type: 'system',
                                        title,
                                        body,
                                        read: false,
                                        activityId,
                                        createdAt: notif.createdAt.toISOString()
                                    }
                                }
                            });
                            isOnline = true;
                        }
                    }

                    if (!isOnline) {
                        pushToUser(p.userId, { title, body, data: { type: 'activity_cancelled', activityId } });
                    }
                }
            }

            return { command: 'cancel-activity', payload: { success: true } };
        } catch (error) {
            logger.error('[Activity] Cancel error', error);
            return { command: 'cancel-activity', payload: { error: 'Internal error' } };
        }
    }
);
