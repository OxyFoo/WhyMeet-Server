import type { AdminPoll, Poll, PollStats, PollVoteValue } from '@oxyfoo/whymeet-types';

import { getDatabase } from '@/services/database';

type PollRow = {
    id: string;
    question: string;
    shopVisible: boolean;
    archived: boolean;
    createdAt: Date;
    updatedAt: Date;
};

function isPollVoteValue(value: unknown): value is PollVoteValue {
    return value === 'up' || value === 'down';
}

function emptyStats(): PollStats {
    return { total: 0, up: 0, down: 0, upRatio: 0, downRatio: 0 };
}

/**
 * Aggregate up/down counts for the given poll ids. Polls with no votes are
 * absent from the returned map (callers default to {@link emptyStats}).
 */
async function getStatsByPoll(pollIds: string[]): Promise<Map<string, PollStats>> {
    const stats = new Map<string, PollStats>();
    if (pollIds.length === 0) return stats;

    const db = getDatabase();
    const grouped = await db.pollVote.groupBy({
        by: ['pollId', 'vote'],
        where: { pollId: { in: pollIds } },
        _count: { _all: true }
    });

    for (const row of grouped) {
        const current = stats.get(row.pollId) ?? emptyStats();
        const count = row._count._all;
        if (row.vote === 'up') current.up += count;
        else if (row.vote === 'down') current.down += count;
        stats.set(row.pollId, current);
    }

    for (const entry of stats.values()) {
        entry.total = entry.up + entry.down;
        entry.upRatio = entry.total > 0 ? entry.up / entry.total : 0;
        entry.downRatio = entry.total > 0 ? entry.down / entry.total : 0;
    }

    return stats;
}

function toAdminPoll(row: PollRow, stats: PollStats): AdminPoll {
    return {
        id: row.id,
        question: row.question,
        shopVisible: row.shopVisible,
        archived: row.archived,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        stats
    };
}

// ─── App-facing (WebSocket) ─────────────────────────────────────────

/**
 * Active (non-archived) polls served to the app, annotated with the given
 * user's current vote. Optionally restricted to shop-visible polls.
 */
export async function getActivePolls(userId: string, shopOnly = false): Promise<Poll[]> {
    const db = getDatabase();
    const polls = await db.poll.findMany({
        where: { archived: false, ...(shopOnly ? { shopVisible: true } : {}) },
        orderBy: { createdAt: 'asc' },
        select: { id: true, question: true, shopVisible: true }
    });
    if (polls.length === 0) return [];

    const votes = await db.pollVote.findMany({
        where: { userId, pollId: { in: polls.map((p) => p.id) } },
        select: { pollId: true, vote: true }
    });
    const voteByPoll = new Map<string, PollVoteValue>();
    for (const v of votes) {
        if (isPollVoteValue(v.vote)) voteByPoll.set(v.pollId, v.vote);
    }

    return polls.map((p) => ({
        id: p.id,
        question: p.question,
        shopVisible: p.shopVisible,
        myVote: voteByPoll.get(p.id) ?? null
    }));
}

/**
 * Cast, change or remove a vote. Passing `vote: null` removes the existing
 * vote. Returns false when the poll does not exist or is archived (the caller
 * should treat this as an ignored late vote).
 */
export async function setVote(userId: string, pollId: string, vote: PollVoteValue | null): Promise<boolean> {
    const db = getDatabase();
    const poll = await db.poll.findUnique({ where: { id: pollId }, select: { archived: true } });
    if (!poll || poll.archived) return false;

    if (vote === null) {
        await db.pollVote.deleteMany({ where: { pollId, userId } });
        return true;
    }

    await db.pollVote.upsert({
        where: { pollId_userId: { pollId, userId } },
        create: { pollId, userId, vote },
        update: { vote, votedAt: new Date() }
    });
    return true;
}

// ─── Console (admin HTTP) ───────────────────────────────────────────

export async function listPollsForAdmin(includeArchived: boolean): Promise<AdminPoll[]> {
    const db = getDatabase();
    const polls = await db.poll.findMany({
        where: includeArchived ? {} : { archived: false },
        orderBy: [{ archived: 'asc' }, { createdAt: 'desc' }]
    });
    const stats = await getStatsByPoll(polls.map((p) => p.id));
    return polls.map((p) => toAdminPoll(p, stats.get(p.id) ?? emptyStats()));
}

export async function createPoll(question: string, shopVisible: boolean): Promise<AdminPoll> {
    const db = getDatabase();
    const poll = await db.poll.create({ data: { question, shopVisible } });
    return toAdminPoll(poll, emptyStats());
}

/** Returns null when the poll does not exist. */
export async function updatePoll(
    id: string,
    data: { question?: string; shopVisible?: boolean }
): Promise<AdminPoll | null> {
    const db = getDatabase();
    const existing = await db.poll.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return null;

    const poll = await db.poll.update({ where: { id }, data });
    const stats = await getStatsByPoll([id]);
    return toAdminPoll(poll, stats.get(id) ?? emptyStats());
}

/** Archives the poll (soft delete). Returns null when the poll does not exist. */
export async function archivePoll(id: string): Promise<AdminPoll | null> {
    const db = getDatabase();
    const existing = await db.poll.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return null;

    const poll = await db.poll.update({ where: { id }, data: { archived: true, shopVisible: false } });
    const stats = await getStatsByPoll([id]);
    return toAdminPoll(poll, stats.get(id) ?? emptyStats());
}
