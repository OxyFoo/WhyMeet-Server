import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_DeleteAccount, WSResponse_DeleteAccount } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { deleteFile, extractKeyFromUrl } from '@/services/storageService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_DeleteAccount>(
    'delete-account',
    async (client: Client, payload): Promise<WSResponse_DeleteAccount> => {
        const { confirmation } = payload;
        const db = getDatabase();

        try {
            // Fetch the user's email for confirmation check
            const user = await db.user.findUnique({ where: { id: client.userId } });
            if (!user) {
                return { command: 'delete-account', payload: { error: 'User not found' } };
            }

            // Require the user to confirm by re-typing their email
            if (confirmation !== user.email) {
                return { command: 'delete-account', payload: { error: 'Confirmation does not match' } };
            }

            // Delete avatar from S3 if exists
            if (user.avatar) {
                const key = extractKeyFromUrl(user.avatar);
                if (key) {
                    deleteFile(key).catch(() => {});
                }
            }

            // Cascade delete: Prisma onDelete: Cascade handles all relations
            await db.user.delete({ where: { id: client.userId } });

            logger.info(`[Account] User deleted: ${client.userId} (${user.email})`);

            // Disconnect the client
            client.close(1000, 'Account deleted');

            return { command: 'delete-account', payload: { success: true } };
        } catch (error) {
            logger.error('[Account] Delete account error', error);
            return { command: 'delete-account', payload: { error: 'Internal error' } };
        }
    }
);
