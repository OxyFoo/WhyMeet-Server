import { prepareUserTagCreateInputs } from '@/services/userTagSync';
import { generateEmbedding, findSimilarTags } from '@/services/embedding';

jest.mock('@/services/embedding', () => ({
    generateEmbedding: jest.fn().mockResolvedValue(null),
    findSimilarTags: jest.fn().mockResolvedValue([])
}));

const mockedGenerateEmbedding = generateEmbedding as jest.MockedFunction<typeof generateEmbedding>;
const mockedFindSimilarTags = findSimilarTags as jest.MockedFunction<typeof findSimilarTags>;

function makeDb({
    exactId,
    exactInsensitiveId,
    aliasId,
    tags = []
}: {
    exactId?: string | null;
    exactInsensitiveId?: string | null;
    aliasId?: string | null;
    tags?: Array<{ id: string; label: string }>;
} = {}) {
    return {
        tag: {
            findUnique: jest.fn().mockResolvedValue(exactId ? { id: exactId } : null),
            findFirst: jest.fn().mockResolvedValue(exactInsensitiveId ? { id: exactInsensitiveId } : null),
            findMany: jest.fn().mockResolvedValue(tags)
        },
        tagAlias: {
            findFirst: jest.fn().mockResolvedValue(aliasId ? { tagId: aliasId } : null),
            create: jest.fn().mockResolvedValue({})
        }
    };
}

describe('userTagSync', () => {
    beforeEach(() => {
        mockedGenerateEmbedding.mockReset().mockResolvedValue(null);
        mockedFindSimilarTags.mockReset().mockResolvedValue([]);
    });
    it('sanitizes labels, normalizes them, and resolves exact canonical tags', async () => {
        const db = makeDb({ exactId: 'tag-1' });

        const rows = await prepareUserTagCreateInputs(
            db as never,
            [{ label: '  gaming  ', source: 'popular' }],
            'interest'
        );

        expect(rows).toEqual([
            {
                label: 'Gaming',
                labelLower: 'gaming',
                labelNorm: 'gaming',
                type: 'interest',
                tagId: 'tag-1',
                source: 'popular'
            }
        ]);
    });

    it('resolves aliases when no exact canonical tag exists', async () => {
        const db = makeDb({ aliasId: 'canonical-1' });

        const rows = await prepareUserTagCreateInputs(
            db as never,
            [{ label: 'video games', source: 'free' }],
            'interest'
        );

        expect(rows[0].tagId).toBe('canonical-1');
        expect(db.tagAlias.findFirst).toHaveBeenCalledWith({
            where: { alias: { equals: 'Video games', mode: 'insensitive' } },
            select: { tagId: true }
        });
    });

    it('resolves canonical tags by normalized label when display labels differ', async () => {
        const db = makeDb({ tags: [{ id: 'tag-time', label: 'Time management' }] });

        const rows = await prepareUserTagCreateInputs(
            db as never,
            [{ label: 'time_management', source: 'free' }],
            'skill'
        );

        expect(rows[0].label).toBe('Time_management');
        expect(rows[0].labelNorm).toBe('time management');
        expect(rows[0].tagId).toBe('tag-time');
        expect(db.tagAlias.create).toHaveBeenCalledWith({
            data: { alias: 'Time_management', tagId: 'tag-time' }
        });
    });

    it('deduplicates incoming variants by normalized label', async () => {
        const db = makeDb();

        const rows = await prepareUserTagCreateInputs(
            db as never,
            [
                { label: 'cinema', source: 'popular' },
                { label: 'Cinéma', source: 'free' }
            ],
            'interest'
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].labelNorm).toBe('cinema');
    });

    it('preserves previous source when the incoming tag does not provide one', async () => {
        const db = makeDb();
        const previous = new Map([['gaming', 'popular']]);

        const rows = await prepareUserTagCreateInputs(db as never, [{ label: 'gaming' }], 'interest', previous);

        expect(rows[0].source).toBe('popular');
    });

    it('falls back to embedding similarity for typos / orthographic variants', async () => {
        const db = makeDb();
        mockedGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
        mockedFindSimilarTags.mockResolvedValue([{ id: 'tag-archery', label: "Tir à l'arc", similarity: 0.92 }]);

        const rows = await prepareUserTagCreateInputs(db as never, [{ label: "tir u l'arc" }], 'interest');

        expect(mockedGenerateEmbedding).toHaveBeenCalledWith("Tir u l'arc");
        expect(mockedFindSimilarTags).toHaveBeenCalledWith([0.1, 0.2, 0.3], 1, 0.85);
        expect(rows[0].tagId).toBe('tag-archery');
        expect(db.tagAlias.create).toHaveBeenCalledWith({
            data: { alias: "Tir u l'arc", tagId: 'tag-archery' }
        });
    });

    it('does not call the embedding API when an earlier resolution path matches', async () => {
        const db = makeDb({ exactId: 'tag-1' });

        await prepareUserTagCreateInputs(db as never, [{ label: 'gaming' }], 'interest');

        expect(mockedGenerateEmbedding).not.toHaveBeenCalled();
        expect(mockedFindSimilarTags).not.toHaveBeenCalled();
    });

    it('returns null tagId when embedding similarity is below the threshold', async () => {
        const db = makeDb();
        mockedGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
        mockedFindSimilarTags.mockResolvedValue([]);

        const rows = await prepareUserTagCreateInputs(db as never, [{ label: 'totally novel concept' }], 'interest');

        expect(rows[0].tagId).toBeNull();
        expect(db.tagAlias.create).not.toHaveBeenCalled();
    });
});
