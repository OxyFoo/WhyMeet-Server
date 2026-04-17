import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type {
    WSRequest_ReportUser,
    WSResponse_ReportUser,
    ReportReason,
    ReportSourceType
} from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { addExcluded } from '@/services/excludeCache';
import { logger } from '@/config/logger';
import { getConnectedClients } from '@/server/Server';

const VALID_REASONS: ReportReason[] = ['spam', 'fake_profile', 'inappropriate', 'hate_speech', 'underage', 'other'];
const VALID_SOURCE_TYPES: ReportSourceType[] = ['profile', 'conversation', 'activity'];
const SUSPENSION_THRESHOLD = 4;

registerCommand<WSRequest_ReportUser>(
    'report-user',
    async (client: Client, payload): Promise<WSResponse_ReportUser> => {
        const { userId: reportedId, reason, sourceType, sourceId, message } = payload;
        const db = getDatabase();

        try {
            if (reportedId === client.userId) {
                return { command: 'report-user', payload: { error: 'Cannot report yourself' } };
            }

            if (!VALID_REASONS.includes(reason)) {
                return { command: 'report-user', payload: { error: 'Invalid reason' } };
            }

            if (!VALID_SOURCE_TYPES.includes(sourceType)) {
                return { command: 'report-user', payload: { error: 'Invalid source type' } };
            }

            if (message && message.length > 500) {
                return { command: 'report-user', payload: { error: 'Message too long (500 max)' } };
            }

            await db.report.upsert({
                where: {
                    reporterId_reportedId: {
                        reporterId: client.userId,
                        reportedId
                    }
                },
                create: {
                    reporterId: client.userId,
                    reportedId,
                    reason,
                    sourceType,
                    sourceId: sourceId ?? null,
                    message: message ?? ''
                },
                update: {
                    reason,
                    sourceType,
                    sourceId: sourceId ?? null,
                    message: message ?? '',
                    status: 'pending'
                }
            });

            logger.info(`[Moderation] User ${client.userId} reported ${reportedId} (${reason}, ${sourceType})`);
            addExcluded(client.userId, reportedId).catch(() => {});

            // Check if the reported user should be suspended
            const reportCount = await db.report.count({
                where: { reportedId }
            });

            if (reportCount >= SUSPENSION_THRESHOLD) {
                const reportedUser = await db.user.findUnique({
                    where: { id: reportedId },
                    select: { suspended: true }
                });

                if (reportedUser && !reportedUser.suspended) {
                    await db.user.update({
                        where: { id: reportedId },
                        data: { suspended: true, suspendedAt: new Date() }
                    });

                    logger.warn(`[Moderation] User ${reportedId} auto-suspended (${reportCount} reports)`);

                    // Disconnect the suspended user if currently connected
                    const clients = getConnectedClients();
                    for (const [, c] of clients) {
                        if (c.userId === reportedId) {
                            c.send({ event: 'suspended', payload: {} });
                            c.close(4002, 'Account suspended');
                        }
                    }
                }
            }

            return { command: 'report-user', payload: { success: true } };
        } catch (error) {
            logger.error('[Moderation] Report error', error);
            return { command: 'report-user', payload: { error: 'Internal error' } };
        }
    }
);
