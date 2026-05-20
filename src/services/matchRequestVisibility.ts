import type { Prisma } from '@prisma/client';
import { getDatabase } from './database';

export async function getHiddenIncomingRequestSenderIds(userId: string): Promise<string[]> {
    const db = getDatabase();
    const [actedOnMatches, blocks] = await Promise.all([
        db.match.findMany({
            where: { senderId: userId },
            distinct: ['receiverId'],
            select: { receiverId: true }
        }),
        db.block.findMany({
            where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
            select: { blockerId: true, blockedId: true }
        })
    ]);

    const hiddenSenderIds = new Set<string>();
    for (const match of actedOnMatches) {
        hiddenSenderIds.add(match.receiverId);
    }
    for (const block of blocks) {
        hiddenSenderIds.add(block.blockerId === userId ? block.blockedId : block.blockerId);
    }

    return [...hiddenSenderIds];
}

export function incomingRequestVisibilityFilter(hiddenSenderIds: string[]): Prisma.MatchWhereInput {
    return hiddenSenderIds.length > 0 ? { senderId: { notIn: hiddenSenderIds } } : {};
}
