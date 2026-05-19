/**
 * Stresstest service — synthetic accounts for load testing.
 *
 * Bots are created via the admin HMAC API (`/admin/stresstest/*`). They are
 * full users marked `bot=true` so they are excluded from real users' discovery
 * (people + activities) and from dashboard counts. The Console uploads their
 * profile photos through the same /upload/photo flow used by real clients, then
 * the bot WebSocket completes profile fields through update-profile.
 *
 * Lifecycle: created on demand by the Console UI; deleted en masse via
 * `cleanupBots()`. Cascade FKs handle most child records; a few entities
 * (Reports, Activities, Conversations, Messages emitted by/towards bots)
 * are wiped explicitly to avoid orphans.
 */
import crypto from 'crypto';
import { getDatabase } from '@/services/database';
import { tokenManager } from '@/services/tokenManager';
import { logger } from '@/config/logger';
import { getClientsForUser, getConnectedClients } from '@/server/Server';
import { deleteFile } from '@/services/storageService';
import { getUsageLimitConfig } from '@/services/usageLimitsService';
import { type UserTagType } from '@/services/userTagSync';
import { ensureTagEmbedding } from '@/services/embedding';
import {
    clearStressBotReservations,
    getReservedStressBotUserIds,
    releaseStressBotReservations,
    reserveStressBots
} from '@/services/stressBotReservations';

let stressBotSelectionQueue = Promise.resolve();

async function withStressBotSelectionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = stressBotSelectionQueue;
    let release!: () => void;
    stressBotSelectionQueue = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await operation();
    } finally {
        release();
    }
}

export interface ReleaseBotsResult {
    releasedReservations: number;
    closedConnections: number;
}

export function releaseBots(userIds: readonly string[]): ReleaseBotsResult {
    const ids = new Set(userIds.filter(Boolean));
    if (ids.size === 0) return { releasedReservations: 0, closedConnections: 0 };

    const releasedReservations = releaseStressBotReservations([...ids]);

    let closedConnections = 0;
    for (const userId of ids) {
        for (const client of getClientsForUser(userId)) {
            client.close(1001, 'Stresstest worker closed');
            closedConnections++;
        }
    }

    return { releasedReservations, closedConnections };
}

// ─── Fake data pools (kept inline — no external faker dependency) ────

const FIRST_NAMES = [
    'Alex',
    'Sam',
    'Charlie',
    'Jordan',
    'Taylor',
    'Morgan',
    'Casey',
    'Riley',
    'Jamie',
    'Quinn',
    'Avery',
    'Reese',
    'Dakota',
    'Skyler',
    'Rowan',
    'Sage',
    'Léo',
    'Mia',
    'Théo',
    'Léa',
    'Hugo',
    'Camille',
    'Louis',
    'Emma',
    'Nathan',
    'Chloé',
    'Lucas',
    'Manon',
    'Adam',
    'Inès',
    'Tom',
    'Lina'
];

// ─── Embedding-resolution test scenario ────────────────────────────────
//
// Each concept seeds a real canonical tag (with a precomputed embedding) and
// a list of "noisy" user-typed variants whose `labelNorm` does NOT match the
// canonical — typos, missing accents, wrong separators, alternate words in
// other languages, etc. Variants must rely on the embedding fallback in
// `resolveCanonicalTagId` to be linked to the canonical.
//
// Goal: confirm that ~15 bots typing 15 different variants of the same
// concept all end up attached to a single canonical tag (visible in the
// Console as `linked` via embedding-resolved aliases).
//
// To keep the OpenAI bill predictable: only ONE concept per type, but with
// enough variants to exceed the bot batch size. Variants are intentionally
// UNIQUE across the list (different `labelNorm` each).

type EmbeddingTestConcept = {
    canonicalLabel: string; // Stored as-is on the Tag row
    type: UserTagType;
    variants: readonly string[];
};

const EMBEDDING_TEST_CONCEPTS: readonly EmbeddingTestConcept[] = [
    {
        canonicalLabel: "Tir à l'arc",
        type: 'interest',
        variants: [
            "tir u l'arc", // typo (u instead of à)
            "tir a l'arc", // missing accent
            'tir à larc', // missing apostrophe
            'tirelarc', // collapsed
            'archery', // english
            'archerie', // french loan from english
            'arc et flèche', // descriptive
            'arc et fleche', // descriptive, no accent
            "tire à l'arc", // typo (tire instead of tir)
            "Tir-à-l'arc", // hyphens
            'tir_a_l_arc', // underscores
            'TIR A L ARC', // upper, spaces
            "tir á l'arc", // wrong accent (á instead of à)
            'arquerie', // alternate french
            'bowman sport', // descriptive english
            'sport de l arc', // descriptive french
            'arc traditionnel', // type of archery
            'arc à poulies', // type of archery
            'tirearc', // collapsed
            'archers' // english plural
        ]
    },
    {
        canonicalLabel: 'Public speaking',
        type: 'skill',
        variants: [
            'public-speaking',
            'publicspeaking',
            'speaking in public',
            'prise de parole',
            'prise de parole en public',
            'parler en public',
            'art oratoire',
            'éloquence',
            'eloquence',
            'oratory',
            'oratory skills',
            'speech delivery',
            'speech giving',
            'presenting',
            'presentation skills',
            'présentation orale',
            'discours public',
            'rhétorique',
            'rhetoric',
            'speech craft'
        ]
    }
];

// Per-process cache so the seeding pass runs at most once per server
// lifetime, even if `spawnBot` is invoked many times in a row.
let embeddingTestSeedPromise: Promise<void> | null = null;

async function seedEmbeddingTestCanonicals(): Promise<void> {
    const db = getDatabase();
    for (const concept of EMBEDDING_TEST_CONCEPTS) {
        const existing = await db.tag.findFirst({
            where: { label: { equals: concept.canonicalLabel, mode: 'insensitive' } },
            select: { id: true, embedding: true }
        });

        let tagId: string;
        if (existing) {
            tagId = existing.id;
            // Already has an embedding → nothing to do.
            if (existing.embedding.length > 0) continue;
        } else {
            const created = await db.tag.create({
                data: { label: concept.canonicalLabel },
                select: { id: true }
            });
            tagId = created.id;
        }

        try {
            await ensureTagEmbedding(tagId, concept.canonicalLabel);
        } catch (error) {
            logger.warn('[Stresstest] Failed to seed embedding test canonical', {
                label: concept.canonicalLabel,
                error
            });
        }
    }
}

function ensureEmbeddingTestCanonicals(): Promise<void> {
    if (!embeddingTestSeedPromise) {
        embeddingTestSeedPromise = seedEmbeddingTestCanonicals().catch((error) => {
            embeddingTestSeedPromise = null; // allow retry on next bot
            throw error;
        });
    }
    return embeddingTestSeedPromise;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Public API ───────────────────────────────────────────────────────

export interface SpawnedBot {
    userId: string;
    username: string;
    email: string;
    deviceUUID: string;
    sessionToken: string;
    wsToken: string;
    reused: boolean;
    needsProfilePhotoUpload: boolean;
}

export interface SpawnBotOptions {
    completeProfile: boolean;
}

export interface PrepareBotsOptions extends SpawnBotOptions {
    count: number;
    excludeUserIds?: string[];
    noReuse?: boolean;
}

export interface PreparedBotsResult {
    bots: SpawnedBot[];
    reused: number;
    created: number;
}

export interface RefreshedBotWSToken {
    userId: string;
    wsToken: string;
}

async function getReusableBotPhotoState(userId: string): Promise<{ needsProfilePhotoUpload: boolean }> {
    const db = getDatabase();
    const profile = await db.profile.findUnique({ where: { userId }, select: { id: true } });
    if (!profile) await db.profile.create({ data: { userId, spokenLanguages: ['fr'] } });
    const photoCount = await db.profilePhoto.count({ where: { userId } });
    return { needsProfilePhotoUpload: photoCount === 0 };
}

async function issueBotCredentials(
    user: { id: string; name: string; email: string },
    profileState: { needsProfilePhotoUpload?: boolean } = {}
): Promise<SpawnedBot> {
    const db = getDatabase();
    const sessionToken = tokenManager.session.generate();
    const sessionTokenHash = tokenManager.hashToken(sessionToken);
    const now = new Date();

    const existingDevice = await db.device.findFirst({
        where: { userId: user.id, name: 'stresstest-bot', os: 'stresstest' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, uuid: true }
    });

    const device = existingDevice
        ? await db.device.update({
              where: { id: existingDevice.id },
              data: {
                  sessionTokenHash,
                  status: 'active',
                  mailTokenHash: null,
                  lastSeenAt: now,
                  integrityVerifiedAt: now
              },
              select: { id: true, uuid: true }
          })
        : await db.device.create({
              data: {
                  uuid: crypto.randomUUID(),
                  sessionTokenHash,
                  status: 'active',
                  name: 'stresstest-bot',
                  os: 'stresstest',
                  userId: user.id,
                  integrityVerifiedAt: now
              },
              select: { id: true, uuid: true }
          });

    const wsToken = tokenManager.ws.generate(user.id, device.id);
    return {
        userId: user.id,
        username: user.name,
        email: user.email,
        deviceUUID: device.uuid,
        sessionToken,
        wsToken,
        reused: true,
        needsProfilePhotoUpload: Boolean(profileState.needsProfilePhotoUpload)
    };
}

export async function refreshBotWSTokens(userIds: readonly string[]): Promise<RefreshedBotWSToken[]> {
    const db = getDatabase();
    const requestedIds = [...new Set(userIds.filter(Boolean))];
    if (requestedIds.length === 0) return [];

    const bots = await db.user.findMany({
        where: {
            id: { in: requestedIds },
            bot: true,
            deleted: false,
            banned: false,
            suspended: false
        },
        select: {
            id: true,
            devices: {
                where: { name: 'stresstest-bot', os: 'stresstest', status: 'active' },
                orderBy: { createdAt: 'asc' },
                take: 1,
                select: { id: true }
            }
        }
    });

    const tokenByUserId = new Map<string, string>();
    for (const bot of bots) {
        const device = bot.devices[0];
        if (!device) continue;
        tokenByUserId.set(bot.id, tokenManager.ws.generate(bot.id, device.id));
    }

    return requestedIds.flatMap((userId) => {
        const wsToken = tokenByUserId.get(userId);
        return wsToken ? [{ userId, wsToken }] : [];
    });
}

/**
 * Create one synthetic user + active device, return ready-to-use credentials.
 * Caller (admin Console) opens a WebSocket using `wsToken` against the same
 * host that serves /admin (the WS server lives on the same HTTP port).
 */
export async function spawnBot(opts: SpawnBotOptions): Promise<SpawnedBot> {
    const db = getDatabase();

    const firstName = pick(FIRST_NAMES);
    const id = crypto.randomBytes(4).toString('hex');
    const email = `bot+${id}@stresstest.invalid`;
    const name = `${firstName}${id.slice(0, 3)}`;

    const sessionToken = tokenManager.session.generate();
    const deviceUUID = crypto.randomUUID();

    const user = await db.user.create({
        data: {
            email,
            name,
            verified: true,
            bot: true,
            profile: { create: { spokenLanguages: ['fr'] } }
        }
    });

    // Pre-activated device (skip mail validation entirely)
    const device = await db.device.create({
        data: {
            uuid: deviceUUID,
            sessionTokenHash: tokenManager.hashToken(sessionToken),
            status: 'active',
            name: 'stresstest-bot',
            os: 'stresstest',
            userId: user.id,
            integrityVerifiedAt: new Date()
        }
    });

    // Quota records mirror POST /auth/enter signup.
    const limits = await getUsageLimitConfig();
    const nextMidnight = new Date();
    nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
    nextMidnight.setUTCHours(0, 0, 0, 0);
    await Promise.all([
        db.searchQuota.create({
            data: { userId: user.id, remaining: limits.initialSearchTokens, resetAt: nextMidnight }
        }),
        db.swipeQuota.create({
            data: {
                userId: user.id,
                remaining: limits.swipeDailyFree,
                resetAt: nextMidnight
            }
        }),
        db.activityQuota.create({
            data: {
                userId: user.id,
                remaining: limits.activityOpenDailyFree,
                resetAt: nextMidnight
            }
        })
    ]);

    const wsToken = tokenManager.ws.generate(user.id, device.id);

    return {
        userId: user.id,
        username: user.name,
        email: user.email,
        deviceUUID,
        sessionToken,
        wsToken,
        reused: false,
        needsProfilePhotoUpload: opts.completeProfile
    };
}

/**
 * Return a ready-to-connect fleet of N bots, reusing existing synthetic
 * accounts first and creating only the missing identities.
 */
export async function prepareBots(opts: PrepareBotsOptions): Promise<PreparedBotsResult> {
    const db = getDatabase();
    const count = Math.max(1, Math.floor(opts.count));
    const reusableBots = await withStressBotSelectionLock(async () => {
        if (opts.noReuse) return [];
        const connectedUserIds = [...getConnectedClients().values()].map((client) => client.userId);
        const reservedUserIds = getReservedStressBotUserIds();
        const excludeUserIds = [
            ...new Set([...(opts.excludeUserIds ?? []), ...connectedUserIds, ...reservedUserIds])
        ].filter(Boolean);

        const bots = await db.user.findMany({
            where: {
                bot: true,
                deleted: false,
                banned: false,
                suspended: false,
                ...(excludeUserIds.length > 0 ? { id: { notIn: excludeUserIds } } : {})
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: count,
            select: { id: true, name: true, email: true }
        });
        reserveStressBots(bots.map((bot) => bot.id));
        return bots;
    });

    if (opts.completeProfile) {
        try {
            await ensureEmbeddingTestCanonicals();
        } catch (error) {
            logger.warn('[Stresstest] Embedding test canonicals seeding failed; continuing', error);
        }
    }

    const reusedBots: SpawnedBot[] = [];
    for (const bot of reusableBots) {
        const profileState = opts.completeProfile
            ? await getReusableBotPhotoState(bot.id)
            : { needsProfilePhotoUpload: false };
        reusedBots.push(await issueBotCredentials(bot, profileState));
    }
    const missing = Math.max(0, count - reusedBots.length);
    const createdBots: SpawnedBot[] = [];

    for (let i = 0; i < missing; i++) {
        const createdBot = await spawnBot(opts);
        reserveStressBots([createdBot.userId]);
        createdBots.push(createdBot);
    }

    reserveStressBots([...reusedBots, ...createdBots].map((bot) => bot.userId));

    return {
        bots: [...reusedBots, ...createdBots],
        reused: reusedBots.length,
        created: createdBots.length
    };
}

export interface CleanupResult {
    deletedUsers: number;
    closedConnections: number;
}

/**
 * Delete every synthetic account and close their live WS connections.
 * Most child rows cascade via Prisma onDelete; a few have SetNull (AuditLog),
 * which is fine — we just leave orphan log rows pointing to nothing.
 */
export async function cleanupBots(): Promise<CleanupResult> {
    const db = getDatabase();
    clearStressBotReservations();

    const bots = await db.user.findMany({ where: { bot: true }, select: { id: true } });
    const botIds = bots.map((b) => b.id);

    if (botIds.length === 0) {
        return { deletedUsers: 0, closedConnections: 0 };
    }

    // Close all live WS connections owned by bots BEFORE deleting (cascade
    // would invalidate FKs mid-flight otherwise).
    let closedConnections = 0;
    for (const c of getConnectedClients().values()) {
        if (botIds.includes(c.userId)) {
            c.close(1001, 'Stresstest cleanup');
            closedConnections++;
        }
    }

    // ─── Conversation cleanup ─────────────────────────────────────────
    //
    // Conversation has no direct FK from User, so user.deleteMany leaves
    // orphan rows behind. We need three buckets:
    //
    //   1. DM conversations (isGroup=false) where a bot participates.
    //      → Always delete. If the other participant is a real user, that
    //        conversation becomes a one-person ghost once the bot is gone;
    //        if the other is also a bot, it's purely synthetic. Either way
    //        it must vanish.
    //
    //   2. Group conversations tied to a bot-hosted activity.
    //      → Delete. The activity itself cascades on user delete; an
    //        unattached "group activity convo" without an activity is junk.
    //
    //   3. Group conversations tied to a real-user activity where a bot
    //      merely participated.
    //      → KEEP. The real activity continues, real participants remain;
    //        the bot's ConversationParticipant row cascades out cleanly.
    //
    // Anything else is unreachable.

    const botActivities = await db.activity.findMany({
        where: { hostId: { in: botIds } },
        select: { conversationId: true }
    });
    const botHostedConvoIds = botActivities
        .map((a) => a.conversationId)
        .filter((c): c is string => typeof c === 'string');

    const botParticipations = await db.conversationParticipant.findMany({
        where: { userId: { in: botIds } },
        select: { conversationId: true, conversation: { select: { isGroup: true } } }
    });
    const botDmConvoIds = botParticipations
        .filter((p) => p.conversation.isGroup === false)
        .map((p) => p.conversationId);

    const convoIdsToDelete = [...new Set([...botDmConvoIds, ...botHostedConvoIds])];
    let deletedConversations = 0;
    if (convoIdsToDelete.length > 0) {
        const convoResult = await db.conversation.deleteMany({ where: { id: { in: convoIdsToDelete } } });
        deletedConversations = convoResult.count;
    }

    // Reports authored by bots OR targeting bots — both reporter and reported
    // user FKs cascade, so this is automatic on user delete. Same for Blocks,
    // Matches, Notifications, Messages, ConversationParticipants, etc.
    //
    // Feedback is the exception: its userId column is `onDelete: SetNull`, so
    // a naive user delete would leave anonymous bot feedbacks haunting the
    // moderation queue. Wipe them explicitly first.
    const feedbackResult = await db.feedback.deleteMany({ where: { userId: { in: botIds } } });

    // Delete S3 photos for every bot before the user cascade wipes their rows.
    // New stress-test photos go through /upload/photo and live under photos/<userId>/;
    // older local-test leftovers may still use stresstest/<userId>/.
    const botPhotos = await db.profilePhoto.findMany({
        where: { userId: { in: botIds } },
        select: { key: true, keyBlurred: true }
    });

    // Also collect activity photos for bot-hosted activities before the cascade drops them.
    const botActivityPhotos = await db.activityPhoto.findMany({
        where: { activity: { hostId: { in: botIds } } },
        select: { key: true, keyBlurred: true }
    });

    const s3Deletions = [
        ...botPhotos.flatMap((p) => [p.key, p.keyBlurred]),
        ...botActivityPhotos.flatMap((p) => [p.key, p.keyBlurred])
    ]
        .filter((k) => !/^https?:\/\//i.test(k))
        .map((k) => deleteFile(k));
    await Promise.allSettled(s3Deletions);

    // Actual user delete:
    const result = await db.user.deleteMany({ where: { bot: true } });

    logger.info(
        `[Stresstest] Cleanup: deleted ${result.count} bots, ${deletedConversations} conversations (${botDmConvoIds.length} DMs + ${botHostedConvoIds.length} activity), ${feedbackResult.count} feedbacks, closed ${closedConnections} WS`
    );

    return { deletedUsers: result.count, closedConnections };
}

export async function countBots(): Promise<number> {
    return getDatabase().user.count({ where: { bot: true } });
}
