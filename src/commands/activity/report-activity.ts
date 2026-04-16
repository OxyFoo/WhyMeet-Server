import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_ReportActivity, WSResponse_ReportActivity, ReportReason } from '@whymeet/types';
import { reportActivity } from '@/services/activityService';
import { logger } from '@/config/logger';

const VALID_REASONS: ReportReason[] = [
    'spam',
    'fake_profile',
    'inappropriate',
    'hate_speech',
    'underage',
    'misleading',
    'dangerous',
    'other'
];

registerCommand<WSRequest_ReportActivity>(
    'report-activity',
    async (client: Client, payload): Promise<WSResponse_ReportActivity> => {
        try {
            const { activityId, reason, message } = payload;

            if (!VALID_REASONS.includes(reason)) {
                return { command: 'report-activity', payload: { error: 'Invalid reason' } };
            }

            const result = await reportActivity(activityId, client.userId, reason, message);
            if (result.error) {
                return { command: 'report-activity', payload: { error: result.error } };
            }

            return { command: 'report-activity', payload: { success: true } };
        } catch (error) {
            logger.error('[Activity] Report error', error);
            return { command: 'report-activity', payload: { error: 'Internal error' } };
        }
    }
);
