import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_ConfirmHostAttendance, WSResponse_ConfirmHostAttendance } from '@oxyfoo/whymeet-types';
import { confirmActivityAsHost } from '@/services/trustScoreService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_ConfirmHostAttendance>(
    'confirm-host-attendance',
    async (client: Client, payload): Promise<WSResponse_ConfirmHostAttendance> => {
        try {
            const { activityId, attendeeCount, absentUserIds } = payload;

            if (!activityId) {
                return { command: 'confirm-host-attendance', payload: { error: 'activityId required' } };
            }

            if (typeof attendeeCount !== 'number' || attendeeCount < 0) {
                return { command: 'confirm-host-attendance', payload: { error: 'Invalid attendeeCount' } };
            }

            const result = await confirmActivityAsHost(activityId, client.userId, attendeeCount, absentUserIds);

            if (result.error) {
                return { command: 'confirm-host-attendance', payload: { error: result.error } };
            }

            return { command: 'confirm-host-attendance', payload: { success: true } };
        } catch (error) {
            logger.error('[Activity] confirm-host-attendance error', error);
            return { command: 'confirm-host-attendance', payload: { error: 'Failed to confirm attendance' } };
        }
    }
);
