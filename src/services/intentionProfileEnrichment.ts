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
