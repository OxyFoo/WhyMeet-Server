import { getDatabase } from '@/services/database';
import { pushToUser } from '@/services/pushService';
import { t, getUserLanguage } from '@/services/notifI18n';
import { logger } from '@/config/logger';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — keeps 1h reminders within ±5 min

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Process a single scheduled activity notif row: dispatch pushes + DB notifications
 * to all participants (respecting settings), then mark `sent=true`.
 * Returns 'sent' if pushes were dispatched, 'skipped' if the activity is gone/cancelled.
 */
export async function processScheduledNotif(id: string): Promise<'sent' | 'skipped' | 'not_found'> {
    const db = getDatabase();
    const now = new Date();

    const notif = await db.activityScheduledNotif.findUnique({
        where: { id },
        include: {
            activity: {
                include: {
                    participants: { select: { userId: true } }
                }
            }
        }
    });

    if (!notif) return 'not_found';
    if (notif.sent) return 'skipped';

    const { activity } = notif;
    if (!activity || activity.isCancelled || activity.isArchived) {
        await db.activityScheduledNotif.update({
            where: { id: notif.id },
            data: { sent: true, sentAt: now }
        });
        return 'skipped';
    }

    const settingKey = notif.type === '24h' ? 'notifActivityReminder24h' : 'notifActivityReminder1h';
    const notifTitleKey =
        notif.type === '24h'
            ? 'activity_reminder_24h_title'
            : notif.type === 'post_event'
              ? 'activity_post_event_title'
              : 'activity_reminder_1h_title';
    const notifBodyKey =
        notif.type === '24h'
            ? 'activity_reminder_24h_body'
            : notif.type === 'post_event'
              ? 'activity_post_event_body'
              : 'activity_reminder_1h_body';
    const notifType = notif.type === 'post_event' ? 'activity_confirm' : 'activity_reminder';

    for (const participant of activity.participants) {
        const { userId } = participant;

        // Check user setting (post_event always sends)
        if (notif.type !== 'post_event') {
            const settings = await db.settings.findUnique({
                where: { userId },
                select: { [settingKey]: true }
            });

            if (settings && settings[settingKey] === false) continue;
        }

        const lang = await getUserLanguage(userId);
        const title = t(lang, notifTitleKey, { title: activity.title });
        const body = t(lang, notifBodyKey, { title: activity.title });

        // Create DB notification
        await db.notification.create({
            data: {
                userId,
                type: notifType,
                title,
                body,
                activityId: activity.id
            }
        });

        // Push
        pushToUser(userId, {
            title,
            body,
            data: { type: notifType, activityId: activity.id }
        });
    }

    await db.activityScheduledNotif.update({
        where: { id: notif.id },
        data: { sent: true, sentAt: now }
    });

    return 'sent';
}

/**
 * Process due activity notifications:
 * 1. Query unsent notifs with scheduledAt <= now
 * 2. For each: dispatch via processScheduledNotif()
 */
async function processScheduledNotifs(): Promise<void> {
    const db = getDatabase();

    try {
        const dueNotifs = await db.activityScheduledNotif.findMany({
            where: {
                sent: false,
                scheduledAt: { lte: new Date() }
            },
            select: { id: true }
        });

        if (dueNotifs.length === 0) return;

        logger.info(`[ActivityNotifScheduler] Processing ${dueNotifs.length} due notifications`);

        let sent = 0;
        let skipped = 0;

        for (const { id } of dueNotifs) {
            try {
                const outcome = await processScheduledNotif(id);
                if (outcome === 'sent') sent++;
                else skipped++;
            } catch (err) {
                logger.error(`[ActivityNotifScheduler] Error on notif ${id}`, err);
                skipped++;
            }
        }

        logger.info(`[ActivityNotifScheduler] Done — sent: ${sent}, skipped: ${skipped}/${dueNotifs.length}`);
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
    }
}
