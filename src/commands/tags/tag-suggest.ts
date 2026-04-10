import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_TagSuggest, WSResponse_TagSuggest, TagSuggestion } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { generateEmbedding, findSimilarTags } from '@/services/embedding';
import { logger } from '@/config/logger';

const MAX_SUGGESTIONS = 10;
const MIN_QUERY_LENGTH = 2;
const SEMANTIC_THRESHOLD = 0.75;

registerCommand<WSRequest_TagSuggest>(
    'tag-suggest',
    async (client: Client, payload): Promise<WSResponse_TagSuggest> => {
        const { query, limit } = payload;
        const maxResults = Math.min(limit ?? MAX_SUGGESTIONS, MAX_SUGGESTIONS);

        // Sanitize: strip invisible/control chars, collapse whitespace, trim
        const trimmed = (query ?? '')
            .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (trimmed.length < MIN_QUERY_LENGTH) {
            return { command: 'tag-suggest', payload: { suggestions: [] } };
        }
        const db = getDatabase();
        const seen = new Set<string>();
        const suggestions: TagSuggestion[] = [];

        try {
            // Step 1: Exact prefix match on Tag.label
            const prefixTags = await db.tag.findMany({
                where: { label: { startsWith: trimmed, mode: 'insensitive' } },
                take: maxResults,
                select: { id: true, label: true }
            });

            for (const tag of prefixTags) {
                if (!seen.has(tag.id)) {
                    seen.add(tag.id);
                    suggestions.push({ tag: { id: tag.id, label: tag.label }, matchType: 'exact' });
                }
            }

            // Step 2: Alias match on TagAlias.alias
            if (suggestions.length < maxResults) {
                const aliasMatches = await db.tagAlias.findMany({
                    where: { alias: { startsWith: trimmed, mode: 'insensitive' } },
                    take: maxResults - suggestions.length,
                    include: { tag: { select: { id: true, label: true } } }
                });

                for (const alias of aliasMatches) {
                    if (!seen.has(alias.tag.id)) {
                        seen.add(alias.tag.id);
                        suggestions.push({
                            tag: { id: alias.tag.id, label: alias.tag.label },
                            matchType: 'alias'
                        });
                    }
                }
            }

            // Step 3: Semantic search if still under threshold
            if (suggestions.length < 5) {
                const embedding = await generateEmbedding(trimmed);
                if (embedding) {
                    const similar = await findSimilarTags(
                        embedding,
                        maxResults - suggestions.length,
                        SEMANTIC_THRESHOLD
                    );

                    for (const match of similar) {
                        if (!seen.has(match.id)) {
                            seen.add(match.id);
                            suggestions.push({
                                tag: { id: match.id, label: match.label },
                                matchType: 'semantic'
                            });
                        }
                    }
                }
            }

            return {
                command: 'tag-suggest',
                payload: { suggestions: suggestions.slice(0, maxResults) }
            };
        } catch (error) {
            logger.error('tag-suggest failed', error);
            return { command: 'tag-suggest', payload: { error: 'Failed to fetch suggestions' } };
        }
    }
);
