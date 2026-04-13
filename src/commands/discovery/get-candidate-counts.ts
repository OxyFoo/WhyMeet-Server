import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetCandidateCounts, WSResponse_GetCandidateCounts, IntentionKey } from '@whymeet/types';
import { getDatabase } from '@/services/database';
import { computeAge, ageToBirthDateRange } from '@/services/userMapper';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetCandidateCounts>(
    'get-candidate-counts',
    async (client: Client): Promise<WSResponse_GetCandidateCounts> => {
        const db = getDatabase();

        try {
            const [currentUser, settings] = await Promise.all([
                db.user.findUnique({
                    where: { id: client.userId },
                    include: { profile: true }
                }),
                db.settings.findUnique({ where: { userId: client.userId } })
            ]);

            const myIntentions = (currentUser?.profile?.intentions ?? []) as IntentionKey[];
            const myGender = currentUser?.gender ?? '';
            const myAge = computeAge(currentUser?.birthDate ?? null);

            const myProfileComplete =
                currentUser?.birthDate != null &&
                myGender !== '' &&
                myIntentions.length > 0 &&
                currentUser?.profile?.latitude != null;

            const prefAgeMin = settings?.discoveryAgeMin ?? 18;
            const prefAgeMax = settings?.discoveryAgeMax ?? 99;
            const prefGenders = settings?.discoveryGenders ?? [];
            const prefIntentions = settings?.discoveryIntentions as IntentionKey[] | undefined;
            const prefVerified = settings?.discoveryVerified ?? false;

            // Exclusion list
            const [seenMatches, blocks, reports] = await Promise.all([
                db.match.findMany({
                    where: { senderId: client.userId },
                    select: { receiverId: true }
                }),
                db.block.findMany({
                    where: { OR: [{ blockerId: client.userId }, { blockedId: client.userId }] },
                    select: { blockerId: true, blockedId: true }
                }),
                db.report.findMany({
                    where: { reporterId: client.userId },
                    select: { reportedId: true }
                })
            ]);

            const seenIds = seenMatches.map((m) => m.receiverId);
            const blockedIds = blocks.map((b) => (b.blockerId === client.userId ? b.blockedId : b.blockerId));
            const reportedIds = reports.map((r) => r.reportedId);
            const excludeIds = [...new Set([client.userId, ...seenIds, ...blockedIds, ...reportedIds])];

            // ── Hard filters ─────────────────────────────────────────
            const where: Record<string, unknown> = {
                id: { notIn: excludeIds },
                banned: false,
                birthDate: { not: null },
                photos: { some: {} },
                tags: { some: {} },
                name: { not: '' }
            };

            const profileWhere: Record<string, unknown> = {
                bio: { not: '' },
                intentions: { isEmpty: false },
                spokenLanguages: { isEmpty: false },
                latitude: { not: null }
            };

            if (prefAgeMin > 18 || prefAgeMax < 99) {
                const { after, before } = ageToBirthDateRange(prefAgeMin, prefAgeMax);
                where.birthDate = { not: null, gte: after, lt: before };
            }

            if (prefGenders.length > 0) {
                where.gender = { in: prefGenders };
            }

            if (prefVerified) {
                where.verified = true;
            }

            if (prefIntentions && prefIntentions.length > 0) {
                profileWhere.intentions = { hasSome: prefIntentions };
            } else if (myIntentions.length > 0) {
                profileWhere.intentions = { hasSome: myIntentions };
            }

            if (Object.keys(profileWhere).length > 0) {
                where.profile = profileWhere;
            }

            // ── Visibility pre-filter ────────────────────────────────
            if (myProfileComplete) {
                const visibilityFilter: Record<string, unknown>[] = [];
                visibilityFilter.push({ visibilityAgeMin: { lte: myAge } });
                visibilityFilter.push({ visibilityAgeMax: { gte: myAge } });

                if (myGender !== '') {
                    visibilityFilter.push({ visibilityGenders: { hasSome: [myGender] } });
                }

                if (myIntentions.length > 0) {
                    visibilityFilter.push({
                        OR: [
                            { visibilityIntentions: { isEmpty: true } },
                            { visibilityIntentions: { hasSome: myIntentions } }
                        ]
                    });
                }

                where.settings = { AND: visibilityFilter };
            }

            // ── Count intentions ─────────────────────────────────────
            const users = await db.user.findMany({
                where,
                select: {
                    profile: { select: { intentions: true } }
                },
                take: 200
            });

            const counts: Record<string, number> = {};
            for (const u of users) {
                const intentions = (u.profile?.intentions ?? []) as string[];
                for (const i of intentions) {
                    counts[i] = (counts[i] || 0) + 1;
                }
            }

            logger.debug(`[Discovery] Candidate counts for user: ${client.userId}`);
            return { command: 'get-candidate-counts', payload: { counts } };
        } catch (error) {
            logger.error('[Discovery] Get candidate counts error', error);
            return { command: 'get-candidate-counts', payload: { error: 'Internal error' } };
        }
    }
);
