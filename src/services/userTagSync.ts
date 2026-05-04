import { getDatabase } from '@/services/database';
import { sanitizeTagLabel, normalizeTagLabel } from '@/services/tagNormalization';
import { generateEmbedding, findSimilarTags } from '@/services/embedding';
import { logger } from '@/config/logger';

// Cosine similarity threshold above which a free-typed label is auto-attached
// to an existing canonical tag. Same value as ALIAS_SIM_THRESHOLD in tagPromotion
// so the two paths stay consistent.
const EMBEDDING_RESOLVE_THRESHOLD = 0.85;

export type UserTagType = 'interest' | 'skill';

export type IncomingUserTag = {
    label: string;
    source?: string | null;
};

export type PreparedUserTagCreate = {
    label: string;
    labelLower: string;
    labelNorm: string;
    type: UserTagType;
    tagId: string | null;
    source: string | null;
};

type Database = ReturnType<typeof getDatabase>;
type TagResolutionDb = Pick<Database, 'tag' | 'tagAlias'>;
type UserTagSyncDb = Pick<Database, 'tag' | 'tagAlias' | 'userTag'>;

async function persistAlias(db: TagResolutionDb, tagId: string, alias: string, context: string): Promise<void> {
    const existing = await db.tagAlias.findFirst({
        where: { alias: { equals: alias, mode: 'insensitive' } },
        select: { id: true }
    });
    if (existing) return;

    try {
        await db.tagAlias.create({ data: { alias, tagId } });
    } catch (error) {
        logger.warn(`Failed to persist ${context} alias`, { alias, tagId, error });
    }
}

/**
 * Resolve a sanitised user-submitted label to an existing canonical tag, if any.
 * Canonical tag creation only happens later in the promotion batch.
 *
 * Resolution order (cheapest first):
 *   1. Exact label match (case-sensitive)
 *   2. Case-insensitive label match
 *   3. Existing alias (case-insensitive)
 *   4. Same normalised label as a canonical tag (handles accents/separators/punctuation)
 *   5. Embedding cosine similarity ≥ EMBEDDING_RESOLVE_THRESHOLD against any
 *      canonical tag (handles typos and orthographic variants like
 *      "tir u l'arc" → "Tir à l'arc"). Successful matches are cached as a new
 *      `TagAlias` row so future occurrences hit step 3 with no embedding cost.
 */
export async function resolveCanonicalTagId(db: TagResolutionDb, label: string): Promise<string | null> {
    const exact = await db.tag.findUnique({ where: { label }, select: { id: true } });
    if (exact) return exact.id;

    const exactInsensitive = await db.tag.findFirst({
        where: { label: { equals: label, mode: 'insensitive' } },
        select: { id: true }
    });
    if (exactInsensitive) return exactInsensitive.id;

    const alias = await db.tagAlias.findFirst({
        where: { alias: { equals: label, mode: 'insensitive' } },
        select: { tagId: true }
    });
    if (alias) return alias.tagId;

    const labelNorm = normalizeTagLabel(label);
    const canonicalTags = await db.tag.findMany({ select: { id: true, label: true } });
    const normalizedMatch = canonicalTags.find((tag) => normalizeTagLabel(tag.label) === labelNorm);
    if (normalizedMatch) {
        if (label.toLowerCase() !== normalizedMatch.label.toLowerCase()) {
            await persistAlias(db, normalizedMatch.id, label, 'normalized-match');
        }
        return normalizedMatch.id;
    }

    return resolveByEmbedding(db, label);
}

async function resolveByEmbedding(db: TagResolutionDb, label: string): Promise<string | null> {
    const embedding = await generateEmbedding(label);
    if (!embedding) return null;

    const matches = await findSimilarTags(embedding, 1, EMBEDDING_RESOLVE_THRESHOLD);
    const match = matches[0];
    if (!match) return null;

    // Cache the resolution as an alias so future occurrences skip the embedding call.
    await persistAlias(db, match.id, label, 'embedding-resolved');

    return match.id;
}

export async function prepareUserTagCreateInputs(
    db: TagResolutionDb,
    incoming: IncomingUserTag[],
    type: UserTagType,
    previousSourceByLabelNorm: Map<string, string | null> = new Map()
): Promise<PreparedUserTagCreate[]> {
    const seen = new Set<string>();
    const rows: PreparedUserTagCreate[] = [];

    for (const raw of incoming) {
        const label = sanitizeTagLabel(raw.label);
        if (!label) continue;

        const labelLower = label.toLowerCase();
        const labelNorm = normalizeTagLabel(label);
        if (!labelNorm || seen.has(labelNorm)) continue;
        seen.add(labelNorm);

        const tagId = await resolveCanonicalTagId(db, label);
        const source = raw.source !== undefined ? raw.source : (previousSourceByLabelNorm.get(labelNorm) ?? null);

        rows.push({ label, labelLower, labelNorm, type, tagId, source });
    }

    return rows;
}

export async function syncUserTags(
    db: UserTagSyncDb,
    userId: string,
    incoming: IncomingUserTag[],
    type: UserTagType
): Promise<void> {
    const previous = await db.userTag.findMany({
        where: { userId, type },
        select: { labelNorm: true, source: true }
    });
    const previousSourceByLabelNorm = new Map<string, string | null>();
    for (const row of previous) previousSourceByLabelNorm.set(row.labelNorm, row.source);

    await db.userTag.deleteMany({ where: { userId, type } });

    const rows = await prepareUserTagCreateInputs(db, incoming, type, previousSourceByLabelNorm);
    for (const row of rows) {
        await db.userTag.create({ data: { userId, ...row } });
    }
}
