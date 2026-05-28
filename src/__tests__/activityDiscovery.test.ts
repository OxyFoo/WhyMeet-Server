jest.mock('@/services/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/swipeQuotaService', () => ({ getSwipeQuota: jest.fn() }));

const mockLoadBotIsolationAccess = jest.fn();
jest.mock('@/services/botIsolationService', () => ({
    loadBotIsolationAccess: (...args: unknown[]) => mockLoadBotIsolationAccess(...args)
}));

import { INTEREST_CATEGORY_KEYS, SOCIAL_VIBES, type InterestCategoryKey } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { getSwipeQuota } from '@/services/swipeQuotaService';
import {
    getActivities,
    getActivityCounts,
    getPopularActivityTags,
    passesAgeFilter
} from '@/services/activityDiscoveryService';

const mockedGetDatabase = getDatabase as jest.MockedFunction<typeof getDatabase>;
const mockedGetSwipeQuota = getSwipeQuota as jest.MockedFunction<typeof getSwipeQuota>;

/** Build a Date such that computeAge() returns exactly `age` today. */
function birthDateForAge(age: number): Date {
    const d = new Date();
    d.setFullYear(d.getFullYear() - age);
    return d;
}

describe('passesAgeFilter', () => {
    it('includes activity when viewer has no birthDate', () => {
        expect(passesAgeFilter(null, [30, 50])).toBe(true);
    });

    it('includes activity when targetAgeRange is empty/malformed', () => {
        expect(passesAgeFilter(birthDateForAge(35), [])).toBe(true);
    });

    it('excludes viewer aged 25 from range [30, 50]', () => {
        expect(passesAgeFilter(birthDateForAge(25), [30, 50])).toBe(false);
    });

    it('includes viewer aged 35 in range [30, 50]', () => {
        expect(passesAgeFilter(birthDateForAge(35), [30, 50])).toBe(true);
    });

    it('excludes viewer aged 55 from range [30, 50]', () => {
        expect(passesAgeFilter(birthDateForAge(55), [30, 50])).toBe(false);
    });

    it('includes viewer aged 85 in range [30, 80] (80+ means no upper bound)', () => {
        expect(passesAgeFilter(birthDateForAge(85), [30, 80])).toBe(true);
    });

    it('includes viewer aged 80 in range [30, 80]', () => {
        expect(passesAgeFilter(birthDateForAge(80), [30, 80])).toBe(true);
    });

    it('excludes viewer aged 25 from range [30, 80]', () => {
        expect(passesAgeFilter(birthDateForAge(25), [30, 80])).toBe(false);
    });
});

type MockActivityOverrides = {
    id?: string;
    category?: string;
    latitude?: number;
    longitude?: number;
    targetAgeRange?: number[];
};

function sqlText(query: unknown): string {
    const maybeSql = query as { sql?: string; text?: string; strings?: string[] };
    return maybeSql.sql ?? maybeSql.text ?? maybeSql.strings?.join('') ?? '';
}

function makeActivity(overrides: MockActivityOverrides = {}) {
    return {
        id: overrides.id ?? 'activity-1',
        title: 'Morning run',
        category: overrides.category ?? INTEREST_CATEGORY_KEYS[0],
        dateTime: new Date('2026-05-08T10:00:00.000Z'),
        locationName: 'Paris',
        latitude: overrides.latitude ?? 48.8566,
        longitude: overrides.longitude ?? 2.3522,
        maxParticipants: 8,
        host: { name: 'Alice' },
        participants: [{ userId: 'host-1' }],
        photos: [{ id: 'photo-1', key: 'activity.webp', keyBlurred: 'activity.blurred.webp', position: 0 }],
        targetGenders: ['male', 'female'],
        targetAgeRange: overrides.targetAgeRange ?? [18, 80]
    };
}

function makeViewer(
    overrides: {
        photos?: { id: string }[];
        tags?: { type: string }[];
        profile?: Partial<{
            latitude: number;
            longitude: number;
            bio: string;
            intentionKeys: string[];
            socialVibe: string;
            spokenLanguages: string[];
        }>;
    } = {}
) {
    return {
        gender: 'male',
        birthDate: birthDateForAge(34),
        bot: false,
        photos: overrides.photos ?? [{ id: 'photo-1' }],
        tags: overrides.tags ?? [
            { type: 'interest' },
            { type: 'interest' },
            { type: 'interest' },
            { type: 'interest' },
            { type: 'interest' },
            { type: 'skill' },
            { type: 'skill' },
            { type: 'skill' },
            { type: 'skill' },
            { type: 'skill' }
        ],
        profile: {
            latitude: 48.8566,
            longitude: 2.3522,
            bio: 'Je sors courir chaque semaine.',
            intentionKeys: ['regular_sports_partner'],
            socialVibe: SOCIAL_VIBES[0],
            spokenLanguages: ['fr'],
            ...(overrides.profile ?? {})
        }
    };
}

function makeActivityDiscoveryDb() {
    return {
        user: {
            findUnique: jest.fn().mockResolvedValue(makeViewer())
        },
        settings: {
            findUnique: jest.fn().mockResolvedValue({
                activityGenders: ['male', 'female'],
                activityMaxDistance: 25,
                activityRemoteMode: false,
                activityVerified: false,
                activityLanguages: ['fr']
            })
        },
        featureFlag: {
            findUnique: jest.fn().mockResolvedValue(null)
        },
        activity: {
            findMany: jest.fn()
        },
        $queryRaw: jest.fn()
    };
}

describe('activity discovery queries', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedGetSwipeQuota.mockResolvedValue({ remaining: 20, dailyLimit: 20 });
        mockLoadBotIsolationAccess.mockResolvedValue({
            allowlistMixingEnabled: false,
            globalMixingEnabled: false,
            viewerAllowlisted: false,
            canBypassBotIsolation: false
        });
    });

    it('loads the first exact SQL page and preserves SQL ordering', async () => {
        const category = INTEREST_CATEGORY_KEYS[0] as InterestCategoryKey;
        const db = makeActivityDiscoveryDb();
        db.$queryRaw.mockResolvedValue([
            { id: 'activity-2', totalCount: 3n },
            { id: 'activity-1', totalCount: 3n }
        ]);
        db.activity.findMany.mockResolvedValue([
            makeActivity({ id: 'activity-1', category }),
            makeActivity({ id: 'activity-2', category })
        ]);
        mockedGetDatabase.mockReturnValue(db as never);

        const result = await getActivities('viewer-activities', {
            category,
            maxDistance: 25,
            tags: ['Yoga']
        });

        expect(result.totalCount).toBe(3);
        expect(result.activities.map((activity) => activity.id)).toEqual(['activity-2', 'activity-1']);
        expect(db.activity.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: { in: ['activity-2', 'activity-1'] } } })
        );

        const query = sqlText(db.$queryRaw.mock.calls[0][0]);
        expect(query).toContain('COUNT(*) OVER()');
        expect(query).toContain('6371 * acos');
        expect(query).toContain('targetAgeRange');
        expect(query).toContain('user_tags filter_tags');
    });

    it('computes category counts in SQL without loading every activity into Node', async () => {
        const category = INTEREST_CATEGORY_KEYS[1] as InterestCategoryKey;
        const db = makeActivityDiscoveryDb();
        db.$queryRaw.mockResolvedValue([{ category, count: 2n }]);
        mockedGetDatabase.mockReturnValue(db as never);

        const counts = await getActivityCounts('viewer-counts');

        expect(counts[category]).toBe(2);
        expect(counts[INTEREST_CATEGORY_KEYS[0]]).toBe(0);
        expect(db.activity.findMany).not.toHaveBeenCalled();

        const query = sqlText(db.$queryRaw.mock.calls[0][0]);
        expect(query).toContain('GROUP BY a.category');
        expect(query).toContain('6371 * acos');
        expect(query).toContain('targetAgeRange');
    });

    it('computes popular tags with the same activity eligibility filters', async () => {
        const category = INTEREST_CATEGORY_KEYS[0] as InterestCategoryKey;
        const db = makeActivityDiscoveryDb();
        db.$queryRaw.mockResolvedValue([{ label: 'Yoga' }, { label: 'Escalade' }]);
        mockedGetDatabase.mockReturnValue(db as never);

        const tags = await getPopularActivityTags('viewer-tags', category);

        expect(tags).toEqual(['Yoga', 'Escalade']);

        const query = sqlText(db.$queryRaw.mock.calls[0][0]);
        expect(query).toContain('JOIN user_tags tags');
        expect(query).toContain('ORDER BY count DESC');
        expect(query).toContain('6371 * acos');
        expect(query).toContain('targetAgeRange');
    });

    it('keeps host bot isolation in activity SQL by default', async () => {
        const category = INTEREST_CATEGORY_KEYS[0] as InterestCategoryKey;
        const db = makeActivityDiscoveryDb();
        db.$queryRaw.mockResolvedValue([{ category, count: 1n }]);
        mockedGetDatabase.mockReturnValue(db as never);

        await getActivityCounts('viewer-bot-filter-default');

        const query = sqlText(db.$queryRaw.mock.calls[0][0]);
        expect(query).toContain('host.bot =');
        expect(mockLoadBotIsolationAccess).toHaveBeenCalledWith('viewer-bot-filter-default', false, expect.anything());
    });

    it('removes host bot isolation in activity SQL for bypassed viewers', async () => {
        const category = INTEREST_CATEGORY_KEYS[0] as InterestCategoryKey;
        const db = makeActivityDiscoveryDb();
        db.$queryRaw.mockResolvedValue([{ category, count: 1n }]);
        mockLoadBotIsolationAccess.mockResolvedValue({
            allowlistMixingEnabled: true,
            globalMixingEnabled: false,
            viewerAllowlisted: true,
            canBypassBotIsolation: true
        });
        mockedGetDatabase.mockReturnValue(db as never);

        await getActivityCounts('viewer-bot-filter-bypass');

        const query = sqlText(db.$queryRaw.mock.calls[0][0]);
        expect(query).not.toContain('host.bot =');
    });

    it('obfuscates activity cards when the viewer profile is incomplete', async () => {
        const category = INTEREST_CATEGORY_KEYS[0] as InterestCategoryKey;
        const db = makeActivityDiscoveryDb();
        db.user.findUnique.mockResolvedValue(makeViewer({ photos: [] }));
        db.$queryRaw.mockResolvedValue([{ id: 'activity-1', totalCount: 1n }]);
        db.activity.findMany.mockResolvedValue([makeActivity({ category })]);
        mockedGetDatabase.mockReturnValue(db as never);

        const result = await getActivities('viewer-incomplete', { category });

        expect(result.activities).toHaveLength(1);
        expect(result.activities[0]).toMatchObject({ blurred: true });
        expect(result.activities[0].photoKey).toBe('activity.blurred.webp');
        expect(result.activities[0].title).not.toBe('Morning run');
        expect(result.activities[0].title).toHaveLength('Morning run'.length);
        expect(result.activities[0].locationName).not.toBe('Paris');
        expect(result.activities[0].hostName).not.toBe('Alice');
    });

    it('can force clear activity cards even when the viewer profile is incomplete', async () => {
        const category = INTEREST_CATEGORY_KEYS[0] as InterestCategoryKey;
        const db = makeActivityDiscoveryDb();
        db.user.findUnique.mockResolvedValue(makeViewer({ photos: [] }));
        db.$queryRaw.mockResolvedValue([{ id: 'activity-1', totalCount: 1n }]);
        db.activity.findMany.mockResolvedValue([makeActivity({ category })]);
        mockedGetDatabase.mockReturnValue(db as never);

        const result = await getActivities('viewer-incomplete', { category }, { obfuscationMode: 'clear' });

        expect(result.activities).toHaveLength(1);
        expect(result.activities[0].blurred).toBeUndefined();
        expect(result.activities[0].photoKey).toBe('activity.webp');
        expect(result.activities[0].title).toBe('Morning run');
        expect(result.activities[0].locationName).toBe('Paris');
        expect(result.activities[0].hostName).toBe('Alice');
    });

    it('obfuscates activity cards by default when the swipe quota is exhausted', async () => {
        const category = INTEREST_CATEGORY_KEYS[0] as InterestCategoryKey;
        const db = makeActivityDiscoveryDb();
        db.$queryRaw.mockResolvedValue([{ id: 'activity-1', totalCount: 1n }]);
        db.activity.findMany.mockResolvedValue([makeActivity({ category })]);
        mockedGetDatabase.mockReturnValue(db as never);
        mockedGetSwipeQuota.mockResolvedValue({ remaining: 0, dailyLimit: 20 });

        const result = await getActivities('viewer-quota-exhausted', { category });

        expect(result.activities).toHaveLength(1);
        expect(result.activities[0]).toMatchObject({ blurred: true });
        expect(result.activities[0].photoKey).toBe('activity.blurred.webp');
    });
});
