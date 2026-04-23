import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_PreviewSearch, WSResponse_PreviewSearch, MatchCandidate } from '@oxyfoo/whymeet-types';
import { mapUserToCandidate } from '@/services/userMapper';
import { runDiscoveryPipeline, DISCOVERY_FETCH_LIMIT } from '@/services/discoveryPipeline';
import { getBoostedUserIds } from '@/services/boostService';
import { interleaveByBoost } from '@/services/interleaveResults';
import { obfuscateString } from '@/services/previewObfuscation';
import { logger } from '@/config/logger';

const MAX_RESULTS = 25;

/** Add slight score jitter (±10 pts) so results with similar scores get shuffled */
function addRandomness(candidates: MatchCandidate[]): MatchCandidate[] {
    return candidates
        .map((c) => ({ c, sortKey: (c.score ?? 0) + (Math.random() - 0.5) * 20 }))
        .sort((a, b) => b.sortKey - a.sortKey)
        .map((x) => x.c);
}

registerCommand<WSRequest_PreviewSearch>(
    'preview-search',
    async (client: Client, payload): Promise<WSResponse_PreviewSearch> => {
        const { filters } = payload;

        try {
            // Single source of truth: same pipeline as get-candidates and get-candidate-counts.
            const { qualified, ctx } = await runDiscoveryPipeline(client, filters, DISCOVERY_FETCH_LIMIT);
            const totalCount = qualified.length;

            const allCandidates = qualified.map((s) => {
                const candidate = mapUserToCandidate(s.user, ctx.prefIntentions, ctx.myLatLng);
                candidate.score = s.score;
                return candidate;
            });

            // Apply 60/40 boost interleave
            const boostedIds = await getBoostedUserIds();
            const interleaved = interleaveByBoost(allCandidates, boostedIds);

            // Add slight randomness and limit to MAX_RESULTS
            const limited = addRandomness(interleaved).slice(0, MAX_RESULTS);

            // Obfuscate data: keep structure (lengths, spaces) but scramble letters
            const randomized = limited.map((c) => {
                const obfuscatedAge = Math.max(18, (c.user.age ?? 25) + Math.floor(Math.random() * 5) - 2);

                return {
                    ...c,
                    user: {
                        ...c.user,
                        name: obfuscateString(c.user.name),
                        age: obfuscatedAge,
                        city: c.user.city ? obfuscateString(c.user.city) : c.user.city
                    },
                    bio: obfuscateString(c.bio),
                    intentions: c.intentions,
                    interests: c.interests.map(obfuscateString),
                    skills: c.skills.map(obfuscateString),
                    distance: c.distance ? obfuscateString(c.distance) : c.distance,
                    blurred: true
                };
            });

            logger.debug(`[Search] ${randomized.length}/${totalCount} preview results for user: ${client.userId}`);
            return { command: 'preview-search', payload: { results: randomized, totalCount } };
        } catch (error) {
            logger.error('[Search] Preview search error', error);
            return { command: 'preview-search', payload: { error: 'Internal error' } };
        }
    }
);
