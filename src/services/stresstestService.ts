/**
 * Stresstest service — synthetic accounts for load testing.
 *
 * Bots are created via the admin HMAC API (`/admin/stresstest/*`). They are
 * full users marked `bot=true` so they are excluded from real users' discovery
 * (people + activities) and from dashboard counts. Profiles are auto-completed
 * with deterministic fake data so they pass `isProfileComplete()` server-side.
 *
 * Lifecycle: created on demand by the Console UI; deleted en masse via
 * `cleanupBots()`. Cascade FKs handle most child records; a few entities
 * (Reports, Activities, Conversations, Messages emitted by/towards bots)
 * are wiped explicitly to avoid orphans.
 */
import crypto from 'crypto';
import sharp from 'sharp';
import { getDatabase } from '@/services/database';
import { tokenManager } from '@/services/tokenManager';
import { logger } from '@/config/logger';
import { getConnectedClients } from '@/server/Server';
import { uploadFile, deleteFile } from '@/services/storageService';
import { getUsageLimitConfig } from '@/services/usageLimitsService';

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

const INTERESTS = [
    'hiking',
    'cooking',
    'reading',
    'gaming',
    'photography',
    'music',
    'cinema',
    'travel',
    'yoga',
    'running',
    'cycling',
    'painting',
    'dancing',
    'climbing',
    'surfing',
    'skiing',
    'tennis',
    'football'
];

const SKILLS = [
    'leadership',
    'creativity',
    'organization',
    'communication',
    'problem_solving',
    'teamwork',
    'adaptability',
    'time_management'
];

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

// 16 distinct hues used to generate bot profile photos. Each bot picks
// `count` colours from this palette (wrapping) and uploads a unique webp
// per photo slot — so 50 bots × 3 photos = 150 individual S3 uploads.
const PHOTO_PALETTE: ReadonlyArray<{ bg: { r: number; g: number; b: number } }> = [
    { bg: { r: 244, g: 114, b: 182 } }, // pink
    { bg: { r: 251, g: 146, b: 60 } }, // orange
    { bg: { r: 250, g: 204, b: 21 } }, // yellow
    { bg: { r: 132, g: 204, b: 22 } }, // lime
    { bg: { r: 34, g: 197, b: 94 } }, // green
    { bg: { r: 14, g: 165, b: 233 } }, // sky
    { bg: { r: 99, g: 102, b: 241 } }, // indigo
    { bg: { r: 168, g: 85, b: 247 } }, // purple
    { bg: { r: 239, g: 68, b: 68 } }, // red
    { bg: { r: 20, g: 184, b: 166 } }, // teal
    { bg: { r: 234, g: 179, b: 8 } }, // amber
    { bg: { r: 6, g: 182, b: 212 } }, // cyan
    { bg: { r: 217, g: 70, b: 239 } }, // fuchsia
    { bg: { r: 16, g: 185, b: 129 } }, // emerald
    { bg: { r: 249, g: 115, b: 22 } }, // orange-600
    { bg: { r: 139, g: 92, b: 246 } } // violet
];

async function buildPhotoBuffer(bg: { r: number; g: number; b: number }, letter: string): Promise<Buffer> {
    const svg = `<svg width="800" height="800" xmlns="http://www.w3.org/2000/svg">
  <text x="50%" y="50%" font-family="sans-serif" font-size="420"
        fill="rgba(255,255,255,0.85)" font-weight="700"
        text-anchor="middle" dominant-baseline="central">${letter}</text>
</svg>`;
    return sharp({
        create: { width: 800, height: 800, channels: 3, background: bg }
    })
        .composite([{ input: Buffer.from(svg), gravity: 'center' }])
        .webp({ quality: 80 })
        .toBuffer();
}

/**
 * Generate and upload `count` unique profile photos for a single bot.
 * Each photo gets a distinct colour from the palette and the bot's initial
 * as the centred letter. Keys are scoped to the bot's userId so there is
 * no sharing between bots and cleanup can target `stresstest/<userId>/`.
 */
async function uploadBotPhotos(userId: string, initial: string, count: number): Promise<string[]> {
    const keys: string[] = [];
    // Pick a random starting offset in the palette so bots don't all start
    // with the same colour sequence.
    const offset = Math.floor(Math.random() * PHOTO_PALETTE.length);
    for (let i = 0; i < count; i++) {
        const { bg } = PHOTO_PALETTE[(offset + i) % PHOTO_PALETTE.length];
        const key = `stresstest/${userId}/photo-${i + 1}.webp`;
        try {
            const buf = await buildPhotoBuffer(bg, initial);
            const result = await uploadFile(buf, key, 'image/webp');
            if (result) {
                keys.push(key);
            } else {
                logger.warn(`[Stresstest] uploadFile returned null for ${key} (S3 disabled?)`);
            }
        } catch (err) {
            logger.warn(`[Stresstest] Failed to upload photo ${key}`, err);
        }
    }
    return keys;
}

/**
 * @deprecated Use uploadBotPhotos() per-bot instead.
 * Kept temporarily so any external callers don't hard-break; remove once
 * confirmed unused.
 */
export async function ensureStresstestPhotosSeeded(): Promise<string[]> {
    logger.warn('[Stresstest] ensureStresstestPhotosSeeded() is deprecated — photos are now uploaded per-bot');
    return [];
}

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
    deviceUUID: string;
    sessionToken: string;
    wsToken: string;
}

export interface SpawnBotOptions {
    completeProfile: boolean;
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

    // Upload unique photos for this bot before creating the DB record so the
    // photo keys are ready to insert in the same transaction-like create call.
    const photoCount = opts.completeProfile ? 2 + Math.floor(Math.random() * 3) : 0;
    const photoKeys = opts.completeProfile ? await uploadBotPhotos(id, name[0].toUpperCase(), photoCount) : [];

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
                      photos: {
                          create: photoKeys.map((key, position) => ({ key, position }))
                      },
                      tags: {
                          // Must be ≥ PROFILE_MIN_TAGS (5) per bucket so that
                          // isProfileComplete() returns true and bots can host
                          // activities + pass profile-completion gates.
                          create: [
                              ...pickN(INTERESTS, 6).map((label) => ({
                                  label,
                                  labelLower: label.toLowerCase(),
                                  type: 'interest' as const
                              })),
                              ...pickN(SKILLS, 5).map((label) => ({
                                  label,
                                  labelLower: label.toLowerCase(),
                                  type: 'skill' as const
                              }))
                          ]
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

    // Token balance + swipe quota (mirrors POST /auth/enter signup)
    const limits = await getUsageLimitConfig();
    const nextMidnight = new Date();
    nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
    nextMidnight.setUTCHours(0, 0, 0, 0);
    await Promise.all([
        db.tokenBalance.create({
            data: { userId: user.id, tokens: limits.initialSearchTokens, lastRefillAt: new Date() }
        }),
        db.swipeQuota.create({
            data: {
                userId: user.id,
                swipesRemaining: limits.swipeDailyFree === -1 ? 0 : limits.swipeDailyFree,
                resetAt: nextMidnight
            }
        })
    ]);

    const wsToken = tokenManager.ws.generate(user.id, device.id);

    return { userId: user.id, deviceUUID, sessionToken, wsToken };
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

    // Delete S3 photos for every bot. Keys are scoped to stresstest/<userId>/
    // so we collect them from the ProfilePhoto table before the user cascade wipes them.
    const botPhotos = await db.profilePhoto.findMany({
        where: { userId: { in: botIds } },
        select: { key: true }
    });
    const s3Deletions = botPhotos
        .filter((p: { key: string }) => p.key.startsWith('stresstest/'))
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
