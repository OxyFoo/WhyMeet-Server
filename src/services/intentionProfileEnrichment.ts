import { logger } from '@/config/logger';
import { getDatabase } from '@/services/database';
import { getAncestorIntentionKeys, type SearchFilters, type IntentionKey } from '@oxyfoo/whymeet-types';
import { normalizeActiveIntentionKeys } from '@/services/intentionKeys';

export function expandSelectedIntentionKeys(keys?: readonly string[] | null): IntentionKey[] {
    const requested = normalizeActiveIntentionKeys(keys);
    const enriched = new Set<IntentionKey>();

    for (const key of requested) {
        for (const ancestorKey of getAncestorIntentionKeys(key)) enriched.add(ancestorKey);
        enriched.add(key);
    }

    return [...enriched];
}

function getSearchedIntentionKeys(filters?: SearchFilters): IntentionKey[] {
    return expandSelectedIntentionKeys(
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
