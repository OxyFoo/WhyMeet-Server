import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_ConfirmParticipation, WSResponse_ConfirmParticipation } from '@oxyfoo/whymeet-types';
import { confirmParticipation } from '@/services/trustScoreService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_ConfirmParticipation>(
    'confirm-participation',
    async (client: Client, payload): Promise<WSResponse_ConfirmParticipation> => {
        try {
            const { activityId, attended } = payload;

            if (!activityId) {
                return { command: 'confirm-participation', payload: { error: 'activityId required' } };
            }

            if (typeof attended !== 'boolean') {
                return { command: 'confirm-participation', payload: { error: 'attended must be a boolean' } };
            }

            const result = await confirmParticipation(activityId, client.userId, attended);

            if (result.error) {
                return { command: 'confirm-participation', payload: { error: result.error } };
            }

            return { command: 'confirm-participation', payload: { success: true } };
        } catch (error) {
            logger.error('[Activity] confirm-participation error', error);
            return { command: 'confirm-participation', payload: { error: 'Failed to confirm participation' } };
        }
    }
);
