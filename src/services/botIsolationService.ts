import type { PrismaClient } from '@prisma/client';
import { getDatabase } from '@/services/database';
import { isFeatureEnabled } from '@/services/featureFlagService';

type BotIsolationDatabase = Pick<PrismaClient, 'botIsolationBypassUser'>;

export type BotIsolationAccess = {
    allowlistMixingEnabled: boolean;
    globalMixingEnabled: boolean;
    viewerAllowlisted: boolean;
    canBypassBotIsolation: boolean;
};

export function resolveCanBypassBotIsolation(input: {
    viewerIsBot: boolean;
    allowlistMixingEnabled: boolean;
    globalMixingEnabled: boolean;
    viewerAllowlisted: boolean;
}): boolean {
    return input.globalMixingEnabled || (input.allowlistMixingEnabled && !input.viewerIsBot && input.viewerAllowlisted);
}

export async function isBotIsolationBypassUser(db: BotIsolationDatabase, userId: string): Promise<boolean> {
    const row = await db.botIsolationBypassUser.findUnique({
        where: { userId },
        select: { id: true }
    });
    return row !== null;
}

export async function loadBotIsolationAccess(
    userId: string,
    viewerIsBot: boolean,
    db: BotIsolationDatabase = getDatabase()
): Promise<BotIsolationAccess> {
    const [allowlistMixingEnabled, globalMixingEnabled, viewerAllowlisted] = await Promise.all([
        isFeatureEnabled('stresstest.bot_user_mixing'),
        isFeatureEnabled('stresstest.bot_user_mixing_global'),
        isBotIsolationBypassUser(db, userId)
    ]);

    return {
        allowlistMixingEnabled,
        globalMixingEnabled,
        viewerAllowlisted,
        canBypassBotIsolation: resolveCanBypassBotIsolation({
            viewerIsBot,
            allowlistMixingEnabled,
            globalMixingEnabled,
            viewerAllowlisted
        })
    };
}
