import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_ReportUser, WSResponse_ReportUser } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

const VALID_REASONS = ['inappropriate', 'spam', 'harassment', 'fake', 'other'];

registerCommand<WSRequest_ReportUser>(
    'report-user',
    async (client: Client, payload): Promise<WSResponse_ReportUser> => {
        const { userId: reportedId, reason, details } = payload;
        const db = getDatabase();

        try {
            if (reportedId === client.userId) {
                return { command: 'report-user', payload: { error: 'Cannot report yourself' } };
            }

            if (!VALID_REASONS.includes(reason)) {
                return { command: 'report-user', payload: { error: 'Invalid reason' } };
            }

            await db.report.create({
                data: {
                    reporterId: client.userId,
                    reportedId,
                    reason,
                    details: details ?? ''
                }
            });

            logger.info(`[Moderation] User ${client.userId} reported ${reportedId} (${reason})`);
            return { command: 'report-user', payload: { success: true } };
        } catch (error) {
            logger.error('[Moderation] Report error', error);
            return { command: 'report-user', payload: { error: 'Internal error' } };
        }
    }
);
