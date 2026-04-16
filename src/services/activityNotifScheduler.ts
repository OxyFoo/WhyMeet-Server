import { getDatabase } from '@/services/database';
import { pushToUser } from '@/services/pushService';
import { t, getUserLanguage } from '@/services/notifI18n';
import { logger } from '@/config/logger';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Process due activity notifications:
 * 1. Query unsent notifs with scheduledAt <= now
 * 2. For each: fetch participants + settings, send push + create DB notification
 * 3. Mark as sent
 */
async function processScheduledNotifs(): Promise<void> {
    const db = getDatabase();
    const now = new Date();

    try {
        const dueNotifs = await db.activityScheduledNotif.findMany({
            where: {
                sent: false,
                scheduledAt: { lte: now }
            },
            include: {
                activity: {
                    include: {
                        participants: { select: { userId: true } }
                    }
                }
            }
        });

        if (dueNotifs.length === 0) return;

        logger.info(`[ActivityNotifScheduler] Processing ${dueNotifs.length} due notifications`);

        for (const notif of dueNotifs) {
            const { activity } = notif;
            if (!activity || activity.isCancelled || activity.isArchived) {
                // Mark as sent to skip in the future
                await db.activityScheduledNotif.update({
                    where: { id: notif.id },
                    data: { sent: true, sentAt: now }
                });
                continue;
            }

            const settingKey = notif.type === '24h' ? 'notifActivityReminder24h' : 'notifActivityReminder1h';
            const notifTitleKey = notif.type === '24h' ? 'activity_reminder_24h_title' : 'activity_reminder_1h_title';
            const notifBodyKey = notif.type === '24h' ? 'activity_reminder_24h_body' : 'activity_reminder_1h_body';

            for (const participant of activity.participants) {
                const { userId } = participant;

                // Check user setting
                const settings = await db.settings.findUnique({
                    where: { userId },
                    select: { [settingKey]: true }
                });

                if (settings && settings[settingKey] === false) continue;

                const lang = await getUserLanguage(userId);
                const title = t(lang, notifTitleKey, { title: activity.title });
                const body = t(lang, notifBodyKey, { title: activity.title });

                // Create DB notification
                await db.notification.create({
                    data: {
                        userId,
                        type: 'activity_reminder',
                        title,
                        body,
                        activityId: activity.id
                    }
                });

                // Push
                pushToUser(userId, {
                    title,
                    body,
                    data: { type: 'activity_reminder', activityId: activity.id }
                });
            }

            // Mark as sent
            await db.activityScheduledNotif.update({
                where: { id: notif.id },
                data: { sent: true, sentAt: now }
            });

            logger.info(`[ActivityNotifScheduler] Sent ${notif.type} reminder for activity ${activity.id}`);
        }
    } catch (error) {
        logger.error('[ActivityNotifScheduler] Error processing notifications', error);
    }
}

/**
 * Start the activity notification scheduler.
 * Should be called once at server boot.
 */
export function startActivityNotifScheduler(): void {
    if (intervalId) return;
    intervalId = setInterval(processScheduledNotifs, CHECK_INTERVAL_MS);
    logger.info(`[ActivityNotifScheduler] Started (interval: ${CHECK_INTERVAL_MS / 1000}s)`);

    // Also run once immediately
    processScheduledNotifs();
}

/**
 * Stop the scheduler (for graceful shutdown).
 */
export function stopActivityNotifScheduler(): void {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        logger.info('[ActivityNotifScheduler] Stopped');
    }
}
