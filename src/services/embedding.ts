import OpenAI from 'openai';
import { env } from '@/config/env';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';
import { resolveDomain } from '@/services/tagDomain';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

let openaiClient: OpenAI | null = null;

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

function getOpenAI(): OpenAI | null {
    if (!env.OPENAI_API_KEY) return null;
    if (!openaiClient) {
        openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
    return openaiClient;
}

/**
 * Generate an embedding vector for the given text.
 * Returns null if OpenAI is not configured.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
    const client = getOpenAI();
    if (!client) return null;

    try {
        const response = await client.embeddings.create({
            model: EMBEDDING_MODEL,
            input: text.toLowerCase().trim(),
            dimensions: EMBEDDING_DIMENSIONS
        });
        return response.data[0].embedding;
    } catch (error) {
        logger.error('Failed to generate embedding', error);
        return null;
    }
}

/**
 * Find tags similar to the given embedding using cosine distance.
 * Embeddings are stored as Float[] in Prisma, so similarity is computed in app
 * code instead of relying on the optional pgvector extension.
 */
export async function findSimilarTags(
    embedding: number[],
    limit: number = 10,
    threshold: number = 0.75
): Promise<Array<{ id: string; label: string; similarity: number }>> {
    const db = getDatabase();

    try {
        const tags = await db.tag.findMany({
            where: { NOT: { embedding: { isEmpty: true } } },
            select: { id: true, label: true, embedding: true }
        });

        return tags
            .map((tag) => ({
                id: tag.id,
                label: tag.label,
                similarity: cosineSimilarity(embedding, tag.embedding)
            }))
            .filter((tag) => tag.similarity >= threshold)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    } catch (error) {
        logger.error('Failed to find similar tags via embeddings', error);
        return [];
    }
}

/**
 * Generate and store embedding for a tag, and resolve its canonical domain.
 * No-op if OpenAI is not configured.
 */
export async function ensureTagEmbedding(tagId: string, label: string): Promise<void> {
    const embedding = await generateEmbedding(label);
    if (!embedding) return;

    // Resolve canonical domain from the freshly-generated embedding.
    // `tagDomain` imports this module for `generateEmbedding`, which creates a
    // circular import at the type level — fine at runtime because the functions
    // are only called after module initialisation.
    const domainKey = await resolveDomain(embedding);

    const db = getDatabase();
    await db.tag.update({
        where: { id: tagId },
        data: { embedding, domainKey }
    });
}
