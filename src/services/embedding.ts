import OpenAI from 'openai';
import { env } from '@/config/env';
import { getDatabase } from '@/services/database';
import { logger } from '@/config/logger';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

let openaiClient: OpenAI | null = null;

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
 * Uses raw SQL since Prisma doesn't natively support pgvector operators.
 * Falls back to empty array if embeddings aren't available.
 */
export async function findSimilarTags(
    embedding: number[],
    limit: number = 10,
    threshold: number = 0.75
): Promise<Array<{ id: string; label: string; similarity: number }>> {
    const db = getDatabase();

    try {
        // Use raw SQL for pgvector cosine similarity
        // cosine distance: 1 - similarity, so we filter where distance < (1 - threshold)
        const maxDistance = 1 - threshold;
        const vectorStr = `[${embedding.join(',')}]`;

        const results = await db.$queryRawUnsafe<Array<{ id: string; label: string; distance: number }>>(
            `SELECT id, label, (embedding::vector <=> $1::vector) as distance
             FROM tags
             WHERE array_length(embedding, 1) IS NOT NULL
               AND (embedding::vector <=> $1::vector) < $2
             ORDER BY distance ASC
             LIMIT $3`,
            vectorStr,
            maxDistance,
            limit
        );

        return results.map((r) => ({
            id: r.id,
            label: r.label,
            similarity: 1 - r.distance
        }));
    } catch (error) {
        logger.error('Failed to find similar tags via embeddings', error);
        return [];
    }
}

/**
 * Generate and store embedding for a tag.
 * No-op if OpenAI is not configured.
 */
export async function ensureTagEmbedding(tagId: string, label: string): Promise<void> {
    const embedding = await generateEmbedding(label);
    if (!embedding) return;

    const db = getDatabase();
    await db.tag.update({
        where: { id: tagId },
        data: { embedding }
    });
}
