import { logger } from '@/config/logger';
import { getDatabase } from '@/services/database';
import type { SearchFilters, IntentionKey } from '@oxyfoo/whymeet-types';
import { normalizeActiveIntentionKeys } from '@/services/intentionKeys';

/**
 * Profile intentionKeys storage is now strict: we store exactly what the user
 * selected, with no ancestor/descendant expansion. Expansion only happens on
 * the query side when matching a category filter against all of its leaves.
 *
 * This avoids the symmetric-expansion bug where two siblings of the same
 * category matched each other through a shared ancestor.
 */
export function normalizeProfileIntentionKeys(keys?: readonly string[] | null): IntentionKey[] {
    return normalizeActiveIntentionKeys(keys);
}

function getSearchedIntentionKeys(filters?: SearchFilters): IntentionKey[] {
    return normalizeProfileIntentionKeys(
        filters?.intentionKeys ?? (filters?.intentionKey ? [filters.intentionKey] : undefined)
    );
}

export async function enrichProfileIntentionsFromFilters(userId: string, filters?: SearchFilters): Promise<void> {
    const searchedIntentionKeys = getSearchedIntentionKeys(filters);
    if (searchedIntentionKeys.length === 0) return;

    try {
        const db = getDatabase();
        const profile = await db.profile.findUnique({
            where: { userId },
            select: { intentionKeys: true }
        });

        const nextKeys = new Set(normalizeActiveIntentionKeys(profile?.intentionKeys ?? []));
        const initialSize = nextKeys.size;

        for (const key of searchedIntentionKeys) {
            nextKeys.add(key);
        }

        if (nextKeys.size === initialSize) return;

        const intentionKeys = [...nextKeys];
        await db.profile.upsert({
            where: { userId },
            update: { intentionKeys },
            create: { userId, intentionKeys }
        });

        logger.debug(`[Profile] Enriched intentions for ${userId}: +${intentionKeys.length - initialSize} key(s)`);
    } catch (error) {
        logger.warn(`[Profile] Failed to enrich intentions for ${userId}`, error);
    }
}

/**
 * Called when a user likes someone in the context of a specific intention.
 * Adds the intention to the liker's profile if not already present.
 * Returns true if the intention was newly added, false if it was already there.
 */
export async function enrichProfileIntentionFromLike(userId: string, intentionKey: IntentionKey): Promise<boolean> {
    try {
        const db = getDatabase();
        const profile = await db.profile.findUnique({
            where: { userId },
            select: { intentionKeys: true }
        });

        const currentKeys = new Set(normalizeActiveIntentionKeys(profile?.intentionKeys ?? []));
        if (currentKeys.has(intentionKey)) return false;

        const nextKeys = [...currentKeys, intentionKey];
        await db.profile.upsert({
            where: { userId },
            update: { intentionKeys: nextKeys },
            create: { userId, intentionKeys: nextKeys }
        });

        logger.info(`[Profile] Intention "${intentionKey}" added from like for user ${userId}`);
        return true;
    } catch (error) {
        logger.warn(`[Profile] Failed to add intention from like for user ${userId}`, error);
        return false;
    }
}
