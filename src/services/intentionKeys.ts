import {
    getCategoryKeyForIntention,
    isIntentionKey,
    type IntentionKey,
    type IntentionSelection
} from '@oxyfoo/whymeet-types';

export function normalizeActiveIntentionKey(value: string | undefined | null): IntentionKey | null {
    return value && isIntentionKey(value) ? value : null;
}

export function normalizeActiveIntentionKeys(values: readonly string[] | undefined | null): IntentionKey[] {
    const normalized = new Set<IntentionKey>();
    for (const value of values ?? []) {
        const intentionKey = normalizeActiveIntentionKey(value);
        if (intentionKey) normalized.add(intentionKey);
    }
    return [...normalized];
}

export function normalizeActiveIntentionSelection(selection: IntentionSelection): IntentionSelection | null {
    const intentionKey = normalizeActiveIntentionKey(selection.intentionKey);
    if (!intentionKey || getCategoryKeyForIntention(intentionKey) !== selection.categoryKey) return null;

    return {
        categoryKey: selection.categoryKey,
        intentionKey,
        tags: selection.tags?.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
        query: selection.query?.trim() || undefined
    };
}
