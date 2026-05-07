/**
 * Stresstest service — synthetic accounts for load testing.
 *
 * Bots are created via the admin HMAC API (`/admin/stresstest/*`). They are
 * full users marked `bot=true` so they are excluded from real users' discovery
 * (people + activities) and from dashboard counts. The Console completes their
 * profile photos through the same /upload/photo flow used by real clients.
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
import { getConnectedClients } from '@/server/Server';
import { deleteFile } from '@/services/storageService';
import { getUsageLimitConfig } from '@/services/usageLimitsService';
import { prepareUserTagCreateInputs, type IncomingUserTag, type UserTagType } from '@/services/userTagSync';
import { ensureTagEmbedding } from '@/services/embedding';

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

const CITIES: Array<{ city: string; lat: number; lng: number }> = [
    { city: 'Paris', lat: 48.8566, lng: 2.3522 },
    { city: 'Lyon', lat: 45.764, lng: 4.8357 },
    { city: 'Marseille', lat: 43.2965, lng: 5.3698 },
    { city: 'Toulouse', lat: 43.6047, lng: 1.4442 },
    { city: 'Bordeaux', lat: 44.8378, lng: -0.5792 },
    { city: 'Nantes', lat: 47.2184, lng: -1.5536 },
    { city: 'Lille', lat: 50.6292, lng: 3.0573 },
    { city: 'Nice', lat: 43.7102, lng: 7.262 }
];

const GENDERS = ['male', 'female', 'non_binary', 'other', 'prefer_not_to_say'];

const INTENTIONS = [
    'dating',
    'serious_relationship',
    'friendship',
    'networking',
    'activity_partner',
    'group_activity',
    'casual_chat'
];

type TagConcept = {
    label: string;
    variants: readonly string[];
    variantChance?: number;
};

const INTEREST_CONCEPTS: readonly TagConcept[] = [
    { label: 'hiking', variants: ['hike', 'randonnée', 'trekking', 'trail walks'] },
    { label: 'cooking', variants: ['cuisine', 'baking', 'food', 'home cooking'] },
    { label: 'reading', variants: ['books', 'lecture', 'novels'] },
    { label: 'gaming', variants: ['video games', 'board games', 'jeux vidéo', 'gaming nights'], variantChance: 0.45 },
    { label: 'photography', variants: ['photo', 'photographie', 'street photography'], variantChance: 0.45 },
    { label: 'music', variants: ['musique', 'concerts', 'live music'] },
    { label: 'cinema', variants: ['cinéma', 'movies', 'films'], variantChance: 0.45 },
    { label: 'travel', variants: ['traveling', 'voyage', 'backpacking', 'city trips'] },
    { label: 'yoga', variants: ['meditation', 'wellness'] },
    { label: 'running', variants: ['jogging', 'trail running', 'run club'] },
    { label: 'cycling', variants: ['bike', 'vélo', 'road cycling'] },
    { label: 'painting', variants: ['art', 'dessin', 'drawing'] },
    { label: 'dancing', variants: ['dance', 'danse', 'salsa'] },
    { label: 'climbing', variants: ['escalade', 'bouldering', 'rock climbing'] },
    { label: 'surfing', variants: ['surf', 'bodyboard'] },
    { label: 'skiing', variants: ['ski', 'snowboard'] },
    { label: 'tennis', variants: ['padel', 'racket sports'] },
    { label: 'football', variants: ['soccer', 'foot', 'five-a-side'] }
];

const SKILL_CONCEPTS: readonly TagConcept[] = [
    { label: 'leadership', variants: ['team leading', 'management', 'mentoring'], variantChance: 0.4 },
    { label: 'creativity', variants: ['creative thinking', 'ideation', 'design thinking'], variantChance: 0.4 },
    { label: 'organization', variants: ['organisation', 'planning', 'project planning'], variantChance: 0.45 },
    { label: 'communication', variants: ['public speaking', 'communication skills', 'active listening'] },
    {
        label: 'problem solving',
        variants: ['problem-solving', 'problem_solving', 'debugging', 'troubleshooting'],
        variantChance: 0.45
    },
    { label: 'teamwork', variants: ['team work', 'collaboration', 'team spirit'], variantChance: 0.4 },
    { label: 'adaptability', variants: ['flexibility', 'adaptation'] },
    {
        label: 'time management',
        variants: ['time-management', 'time_management', 'prioritization', 'planning ahead'],
        variantChance: 0.45
    }
];

const TRENDING_INTEREST_LABELS = ['gaming', 'photography', 'cinema'];
const TRENDING_SKILL_LABELS = ['organization', 'problem solving', 'time management'];

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

// Probability that a given bot picks a variant from the embedding test pool
// instead of (or in addition to) its regular tags. With 50 bots and 0.35,
// ~17 bots end up exercising the embedding fallback per type.
const EMBEDDING_TEST_BOT_PROBABILITY = 0.35;
const TAG_TYPO_PROBABILITY = 0.06;
const TAG_TYPO_REPLACEMENT_CHARS = 'abcdefghijklmnopqrstuvwxyz';

function pickEmbeddingTestVariant(type: UserTagType): IncomingUserTag | null {
    if (Math.random() >= EMBEDDING_TEST_BOT_PROBABILITY) return null;
    const concepts = EMBEDDING_TEST_CONCEPTS.filter((concept) => concept.type === type);
    if (concepts.length === 0) return null;
    const concept = pick(concepts);
    return { label: pick(concept.variants), source: 'free' };
}

/**
 * Maybe replace one of the bot's tags with an embedding-test variant so that
 * across a batch we get ~15 bots typing different noisy variants of the same
 * canonical concept. Replacement (rather than append) keeps the bot's total
 * tag count stable so it still passes profile completeness checks.
 */
function mergeWithEmbeddingTestVariant(tags: IncomingUserTag[], type: UserTagType): IncomingUserTag[] {
    const variant = pickEmbeddingTestVariant(type);
    if (!variant || tags.length === 0) return tags;
    const replaceIndex = Math.floor(Math.random() * tags.length);
    const next = [...tags];
    next[replaceIndex] = variant;
    return next;
}

function replaceRandomTagCharacters(label: string): string {
    const chars = [...label];
    const candidateIndexes = chars
        .map((char, index) => ({ char, index }))
        .filter(({ char }) => /[\p{L}\p{N}]/u.test(char))
        .map(({ index }) => index);

    if (candidateIndexes.length === 0) return label;

    const replacementCount = 1 + Math.floor(Math.random() * Math.min(3, candidateIndexes.length));
    const indexes = pickN(candidateIndexes, replacementCount);

    for (const index of indexes) {
        const current = chars[index];
        let replacement = pick([...TAG_TYPO_REPLACEMENT_CHARS]);
        while (replacement.toLowerCase() === current.toLowerCase()) {
            replacement = pick([...TAG_TYPO_REPLACEMENT_CHARS]);
        }
        if (current.toUpperCase() === current && current.toLowerCase() !== current) {
            replacement = replacement.toUpperCase();
        }
        chars[index] = replacement;
    }

    return chars.join('');
}

function applyRandomTagTypos(tags: IncomingUserTag[]): IncomingUserTag[] {
    return tags.map((tag) => {
        if (Math.random() >= TAG_TYPO_PROBABILITY) return tag;
        return { ...tag, label: replaceRandomTagCharacters(tag.label), source: 'free' };
    });
}

// Must match SocialVibe enum from @oxyfoo/whymeet-types — invalid values
// would not satisfy isProfileComplete() and silently break bots' ability to
// host activities or appear in discovery.
const VIBES = ['reserved', 'calm', 'balanced', 'outgoing', 'very_social'];

const BIOS = [
    'Looking for new connections.',
    'Always up for an adventure.',
    'Coffee enthusiast and book lover.',
    'Music, movies, and good conversations.',
    'Outdoor person, weekend explorer.',
    'Creative soul exploring the city.'
];

// ─── Helpers ──────────────────────────────────────────────────────────

function pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: readonly T[], n: number): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.min(n, copy.length));
}

function pickBotTags(
    concepts: readonly TagConcept[],
    count: number,
    trendingLabels: readonly string[] = []
): IncomingUserTag[] {
    const trending = trendingLabels
        .map((label) => concepts.find((concept) => concept.label === label))
        .filter((concept): concept is TagConcept => Boolean(concept));
    const rest = concepts.filter((concept) => !trendingLabels.includes(concept.label));
    const picked = [...trending.slice(0, count), ...pickN(rest, Math.max(0, count - trending.length))];

    return picked.map((concept) => {
        if (Math.random() >= (concept.variantChance ?? 0.35)) return { label: concept.label, source: 'popular' };
        return { label: pick(concept.variants), source: 'free' };
    });
}

function randomBirthDate(): Date {
    // Age 18 → 65
    const ageYears = 18 + Math.floor(Math.random() * 48);
    const now = new Date();
    const year = now.getUTCFullYear() - ageYears;
    const month = Math.floor(Math.random() * 12);
    const day = 1 + Math.floor(Math.random() * 28);
    return new Date(Date.UTC(year, month, day));
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
}

export interface PreparedBotsResult {
    bots: SpawnedBot[];
    reused: number;
    created: number;
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
    const gender = pick(GENDERS);
    const birthDate = randomBirthDate();
    const loc = pick(CITIES);
    // Jitter ~5 km around city
    const lat = loc.lat + (Math.random() - 0.5) * 0.1;
    const lng = loc.lng + (Math.random() - 0.5) * 0.1;

    const sessionToken = tokenManager.session.generate();
    const deviceUUID = crypto.randomUUID();

    // Make sure the canonical tags + embeddings used by the embedding-resolution
    // test scenario exist. Idempotent across bots; first bot of the batch pays
    // the OpenAI cost (one embedding per concept), the rest are no-ops.
    if (opts.completeProfile) {
        try {
            await ensureEmbeddingTestCanonicals();
        } catch (error) {
            logger.warn('[Stresstest] Embedding test canonicals seeding failed; continuing', error);
        }
    }

    const interestTags = opts.completeProfile
        ? applyRandomTagTypos(
              mergeWithEmbeddingTestVariant(pickBotTags(INTEREST_CONCEPTS, 6, TRENDING_INTEREST_LABELS), 'interest')
          )
        : [];
    const skillTags = opts.completeProfile
        ? applyRandomTagTypos(
              mergeWithEmbeddingTestVariant(pickBotTags(SKILL_CONCEPTS, 5, TRENDING_SKILL_LABELS), 'skill')
          )
        : [];
    const tagRows = opts.completeProfile
        ? [
              ...(await prepareUserTagCreateInputs(db, interestTags, 'interest')),
              ...(await prepareUserTagCreateInputs(db, skillTags, 'skill'))
          ]
        : [];

    const user = await db.user.create({
        data: {
            email,
            name,
            gender,
            city: loc.city,
            birthDate,
            verified: true,
            bot: true,
            preferredPeriod: pick(['morning', 'afternoon', 'evening', 'night', 'any']),
            ...(opts.completeProfile
                ? {
                      profile: {
                          create: {
                              bio: pick(BIOS),
                              socialVibe: pick(VIBES),
                              country: 'France',
                              region: '',
                              city: loc.city,
                              latitude: lat,
                              longitude: lng,
                              intentions: pickN(INTENTIONS, 1 + Math.floor(Math.random() * 3)),
                              spokenLanguages: ['fr']
                          }
                      },
                      tags: {
                          // Must be ≥ PROFILE_MIN_TAGS (5) per bucket so that
                          // isProfileComplete() returns true and bots can host
                          // activities + pass profile-completion gates.
                          create: tagRows
                      }
                  }
                : {
                      profile: { create: { spokenLanguages: ['fr'] } }
                  })
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
    const excludeUserIds = [...new Set(opts.excludeUserIds ?? [])].filter(Boolean);

    const reusableBots = await db.user.findMany({
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
        createdBots.push(await spawnBot(opts));
    }

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
        select: { key: true }
    });
    const s3Deletions = botPhotos
        .filter((p: { key: string }) => !/^https?:\/\//i.test(p.key))
        .map((p: { key: string }) => deleteFile(p.key));
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
