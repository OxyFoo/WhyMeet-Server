import { logger } from '@/config/logger';
import { getDatabase } from '@/services/database';
import type { SearchFilters, IntentionKey, IntentionCategoryKey } from '@oxyfoo/whymeet-types';
import { getCategoryKeyForIntention } from '@oxyfoo/whymeet-types';
import { normalizeActiveIntentionKeys, normalizeActiveIntentionCategoryKeys } from '@/services/intentionKeys';

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

/**
 * Returns the set of parent category keys for the given intention keys.
 * Used everywhere an intention is added to a profile: the matching category
 * must always be present too, so that category-level discovery matches still
 * surface the user.
 */
export function getParentCategoryKeysForIntentions(intentionKeys: readonly IntentionKey[]): IntentionCategoryKey[] {
    const set = new Set<IntentionCategoryKey>();
    for (const key of intentionKeys) {
        try {
            set.add(getCategoryKeyForIntention(key));
        } catch {
            // Unknown / legacy intention key: skip silently — normalization
            // upstream already drops anything not in the catalog.
        }
    }
    return [...set];
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
            select: { intentionKeys: true, intentionCategoryKeys: true }
        });

        const nextKeys = new Set(normalizeActiveIntentionKeys(profile?.intentionKeys ?? []));
        const initialKeysSize = nextKeys.size;
        for (const key of searchedIntentionKeys) {
            nextKeys.add(key);
        }

        const nextCategoryKeys = new Set(normalizeActiveIntentionCategoryKeys(profile?.intentionCategoryKeys ?? []));
        const initialCategorySize = nextCategoryKeys.size;
        for (const cat of getParentCategoryKeysForIntentions(searchedIntentionKeys)) {
            nextCategoryKeys.add(cat);
        }

        const addedKeys = nextKeys.size - initialKeysSize;
        const addedCategories = nextCategoryKeys.size - initialCategorySize;
        if (addedKeys === 0 && addedCategories === 0) return;

        const intentionKeys = [...nextKeys];
        const intentionCategoryKeys = [...nextCategoryKeys];
        await db.profile.upsert({
            where: { userId },
            update: { intentionKeys, intentionCategoryKeys },
            create: { userId, intentionKeys, intentionCategoryKeys }
        });

        logger.debug(
            `[Profile] Enriched intentions for ${userId}: +${addedKeys} intention(s), +${addedCategories} category(ies)`
        );
    } catch (error) {
        logger.warn(`[Profile] Failed to enrich intentions for ${userId}`, error);
    }
}

/**
 * Called when a user likes someone in the context of a specific intention.
 * Adds the intention (and its parent category) to the liker's profile if not
 * already present. Returns true if the intention was newly added, false if it
 * was already there. (The parent category is added regardless, silently.)
 */
export async function enrichProfileIntentionFromLike(userId: string, intentionKey: IntentionKey): Promise<boolean> {
    try {
        const db = getDatabase();
        const profile = await db.profile.findUnique({
            where: { userId },
            select: { intentionKeys: true, intentionCategoryKeys: true }
        });

        const currentKeys = new Set(normalizeActiveIntentionKeys(profile?.intentionKeys ?? []));
        const currentCategoryKeys = new Set(normalizeActiveIntentionCategoryKeys(profile?.intentionCategoryKeys ?? []));

        const intentionAlreadyPresent = currentKeys.has(intentionKey);
        const [parentCategory] = getParentCategoryKeysForIntentions([intentionKey]);
        const categoryAlreadyPresent = parentCategory ? currentCategoryKeys.has(parentCategory) : true;

        if (intentionAlreadyPresent && categoryAlreadyPresent) return false;

        currentKeys.add(intentionKey);
        if (parentCategory) currentCategoryKeys.add(parentCategory);

        const intentionKeys = [...currentKeys];
        const intentionCategoryKeys = [...currentCategoryKeys];
        await db.profile.upsert({
            where: { userId },
            update: { intentionKeys, intentionCategoryKeys },
            create: { userId, intentionKeys, intentionCategoryKeys }
        });

        if (!intentionAlreadyPresent) {
            logger.info(`[Profile] Intention "${intentionKey}" added from like for user ${userId}`);
        }
        if (parentCategory && !categoryAlreadyPresent) {
            logger.info(
                `[Profile] Category "${parentCategory}" auto-added for user ${userId} (from intention "${intentionKey}")`
            );
        }
        return !intentionAlreadyPresent;
    } catch (error) {
        logger.warn(`[Profile] Failed to add intention from like for user ${userId}`, error);
        return false;
    }
}
