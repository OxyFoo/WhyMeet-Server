import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_MarkNotificationRead, WSResponse_MarkNotificationRead } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_MarkNotificationRead>(
    'mark-notification-read',
    async (client: Client, payload): Promise<WSResponse_MarkNotificationRead> => {
        const { notificationId } = payload;
        const db = getDatabase();

        try {
            // Verify the notification belongs to the user
            const notification = await db.notification.findUnique({
                where: { id: notificationId }
            });

            if (!notification || notification.userId !== client.userId) {
                return { command: 'mark-notification-read', payload: { error: 'Notification not found' } };
            }

            await db.notification.update({
                where: { id: notificationId },
                data: { read: true }
            });

            return { command: 'mark-notification-read', payload: { success: true } };
        } catch (error) {
            logger.error('[Notifications] Mark read error', error);
            return { command: 'mark-notification-read', payload: { error: 'Internal error' } };
        }
    }
);
