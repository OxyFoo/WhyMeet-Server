import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidates, WSResponse_GetCandidates, IntentionKey } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { mapUserToCandidate, candidateInclude, getDistanceKm } from '@/services/userMapper';
import { logger } from '@/config/logger';

const DEFAULT_MAX_DISTANCE = 50; // km

registerCommand<WSRequest_GetCandidates>(
    'get-candidates',
    async (client: Client, payload): Promise<WSResponse_GetCandidates> => {
        const db = getDatabase();
        const filters = payload.filters;

        try {
            // Get current user's profile for scoring
            const currentUser = await db.user.findUnique({
                where: { id: client.userId },
                include: { profile: true, tags: { include: { tag: true } } }
            });

            const myIntentions = (currentUser?.profile?.intentions ?? []) as IntentionKey[];
            const myTagLabels = new Set((currentUser?.tags ?? []).map((t) => t.tag.label));
            const myLatLng = {
                latitude: currentUser?.profile?.latitude ?? null,
                longitude: currentUser?.profile?.longitude ?? null
            };

            // Get IDs already seen (liked/skipped/starred)
            const seenMatches = await db.match.findMany({
                where: { senderId: client.userId },
                select: { receiverId: true }
            });
            const seenIds = seenMatches.map((m) => m.receiverId);

            // Get blocked users (in both directions)
            const blocks = await db.block.findMany({
                where: { OR: [{ blockerId: client.userId }, { blockedId: client.userId }] },
                select: { blockerId: true, blockedId: true }
            });
            const blockedIds = blocks.map((b) => (b.blockerId === client.userId ? b.blockedId : b.blockerId));

            // Build query
            const where: Record<string, unknown> = {
                id: { notIn: [client.userId, ...seenIds, ...blockedIds] }
            };

            // Filter by specific intentions if provided
            if (filters?.intentions && filters.intentions.length > 0) {
                where.profile = { intentions: { hasSome: filters.intentions } };
            } else if (myIntentions.length > 0) {
                where.profile = { intentions: { hasSome: myIntentions } };
            }

            // Remote mode: filter by spoken languages
            if (filters?.remote && filters?.languages && filters.languages.length > 0) {
                where.profile = {
                    ...((where.profile as Record<string, unknown>) ?? {}),
                    spokenLanguages: { hasSome: filters.languages }
                };
            }

            const users = await db.user.findMany({
                where,
                include: candidateInclude,
                take: 100 // fetch more to allow post-filtering by distance
            });

            // Score and sort by relevance
            const targetIntentions = filters?.intentions;
            const isRemote = filters?.remote === true;
            const maxDistance = isRemote ? Infinity : (filters?.maxDistance ?? DEFAULT_MAX_DISTANCE);

            const scored = users
                .map((u) => {
                    const theirIntentions = (u.profile?.intentions ?? []) as IntentionKey[];
                    const theirTags = new Set((u.tags ?? []).map((t) => t.tag.label));
                    const distKm = getDistanceKm(
                        myLatLng.latitude,
                        myLatLng.longitude,
                        u.profile?.latitude,
                        u.profile?.longitude
                    );

                    let score = 0;
                    for (const i of theirIntentions) {
                        if (myIntentions.includes(i)) score += 2;
                    }
                    for (const t of theirTags) {
                        if (myTagLabels.has(t)) score += 1;
                    }

                    return { user: u, score, distKm };
                })
                // Filter by distance (skip if location unknown)
                .filter((s) => {
                    if (isRemote) return true;
                    if (s.distKm == null) return true; // include users without location
                    return s.distKm <= maxDistance;
                });

            scored.sort((a, b) => b.score - a.score);

            const candidates = scored.slice(0, 20).map((s) => mapUserToCandidate(s.user, targetIntentions, myLatLng));

            logger.debug(`[Discovery] ${candidates.length} candidates for user: ${client.userId}`);
            return { command: 'get-candidates', payload: { candidates } };
        } catch (error) {
            logger.error('[Discovery] Get candidates error', error);
            return { command: 'get-candidates', payload: { error: 'Internal error' } };
        }
    }
);
