import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_SubmitFeedback, WSResponse_SubmitFeedback, FeedbackType } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

const VALID_TYPES: FeedbackType[] = ['bug', 'suggestion', 'other'];
const MAX_MESSAGE_LENGTH = 1000;

registerCommand<WSRequest_SubmitFeedback>(
    'submit-feedback',
    async (client: Client, payload): Promise<WSResponse_SubmitFeedback> => {
        const { type, message } = payload;
        const db = getDatabase();

        try {
            if (!VALID_TYPES.includes(type)) {
                return { command: 'submit-feedback', payload: { error: 'Invalid type' } };
            }

            const trimmed = (message ?? '').trim();
            if (trimmed.length === 0) {
                return { command: 'submit-feedback', payload: { error: 'Message required' } };
            }
            if (trimmed.length > MAX_MESSAGE_LENGTH) {
                return {
                    command: 'submit-feedback',
                    payload: { error: `Message too long (${MAX_MESSAGE_LENGTH} max)` }
                };
            }

            await db.feedback.create({
                data: {
                    userId: client.userId,
                    type,
                    message: trimmed
                }
            });

            logger.info(`[Feedback] User ${client.userId} submitted feedback (${type})`);

            return { command: 'submit-feedback', payload: { success: true } };
        } catch (error) {
            logger.error('[Feedback] Submit error', error);
            return { command: 'submit-feedback', payload: { error: 'Internal error' } };
        }
    }
);
