import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_ForgotPassword, WSResponse_ForgotPassword } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

registerCommand<WSRequest_ForgotPassword>(
    'forgot-password',
    async (_client: Client, payload): Promise<WSResponse_ForgotPassword> => {
        const { email } = payload;
        const db = getDatabase();

        try {
            const user = await db.user.findUnique({ where: { email } });
            if (!user) {
                // Don't reveal whether email exists
                return { command: 'forgot-password', payload: { success: true } };
            }

            // TODO: Send password reset email
            logger.info(`[Auth] Password reset requested for: ${email}`);

            return { command: 'forgot-password', payload: { success: true } };
        } catch (error) {
            logger.error('[Auth] Forgot password error', error);
            return { command: 'forgot-password', payload: { error: 'Internal error' } };
        }
    }
);
