import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_VotePoll, WSResponse_VotePoll, PollVoteValue } from '@oxyfoo/whymeet-types';
import { setVote } from '@/services/pollService';
import { logger } from '@/config/logger';

function isVote(value: unknown): value is PollVoteValue {
    return value === 'up' || value === 'down';
}

registerCommand<WSRequest_VotePoll>('vote-poll', async (client: Client, payload): Promise<WSResponse_VotePoll> => {
    const { pollId } = payload;
    const vote = payload.vote;

    if (typeof pollId !== 'string' || pollId.length === 0) {
        return { command: 'vote-poll', payload: { error: 'Invalid poll' } };
    }
    if (vote !== null && !isVote(vote)) {
        return { command: 'vote-poll', payload: { error: 'Invalid vote' } };
    }

    try {
        const applied = await setVote(client.userId, pollId, vote);
        if (!applied) {
            // Archived or unknown poll: ignore the late vote but tell the client.
            logger.info(`[Polls] Ignored vote on unavailable poll ${pollId} by user ${client.userId}`);
            return { command: 'vote-poll', payload: { error: 'Poll unavailable' } };
        }
        return { command: 'vote-poll', payload: { pollId, vote } };
    } catch (err) {
        logger.error(`[Polls] vote-poll failed for user ${client.userId} on ${pollId}: ${(err as Error).message}`);
        return { command: 'vote-poll', payload: { error: 'Failed to save vote' } };
    }
});
