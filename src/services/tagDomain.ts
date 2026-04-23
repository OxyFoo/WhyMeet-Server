import type { InterestCategoryKey } from '@oxyfoo/whymeet-types';
import { INTEREST_CATEGORIES } from '@oxyfoo/whymeet-types';
import { generateEmbedding } from '@/services/embedding';
import { logger } from '@/config/logger';

/**
 * Minimum cosine similarity (on normalised embeddings) required to assign a
 * tag to a domain. Below this threshold we leave `domainKey` null rather than
 * forcing a wrong category.
 */
const DOMAIN_THRESHOLD = 0.55;

let categoryEmbeddings: Map<InterestCategoryKey, number[]> | null = null;
let initPromise: Promise<void> | null = null;

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Lazily compute one embedding per interest category (label + description).
 * Safe to call multiple times — guarded by a single in-flight promise.
 * No-op when OpenAI is not configured (generateEmbedding returns null).
 */
async function ensureCategoryEmbeddings(): Promise<void> {
    if (categoryEmbeddings !== null) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const map = new Map<InterestCategoryKey, number[]>();
        for (const cat of INTEREST_CATEGORIES) {
            const text = `${cat.label}. ${cat.description}`;
            const emb = await generateEmbedding(text);
            if (emb) map.set(cat.key, emb);
        }
        categoryEmbeddings = map;
        if (map.size === 0) {
            logger.warn('[tagDomain] No category embeddings (OpenAI disabled?). Domain resolution disabled.');
        } else {
            logger.info(`[tagDomain] Initialised ${map.size} category embeddings`);
        }
    })();

    try {
        await initPromise;
    } finally {
        initPromise = null;
    }
}

/**
 * Resolve the closest interest-category domain for a tag embedding.
 * Returns null when no category meets the similarity threshold, or when
 * embeddings are unavailable.
 */
export async function resolveDomain(tagEmbedding: number[] | null | undefined): Promise<InterestCategoryKey | null> {
    if (!tagEmbedding || tagEmbedding.length === 0) return null;

    await ensureCategoryEmbeddings();
    if (!categoryEmbeddings || categoryEmbeddings.size === 0) return null;

    let bestKey: InterestCategoryKey | null = null;
    let bestSim = -Infinity;
    for (const [key, emb] of categoryEmbeddings) {
        const sim = cosineSimilarity(tagEmbedding, emb);
        if (sim > bestSim) {
            bestSim = sim;
            bestKey = key;
        }
    }

    if (bestSim < DOMAIN_THRESHOLD) return null;
    return bestKey;
}
