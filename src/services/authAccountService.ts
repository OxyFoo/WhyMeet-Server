import type { PrismaClient } from '@prisma/client';
import { profileInclude } from '@/services/userMapper';
import { tokenManager } from '@/services/tokenManager';
import { getUsageLimitConfig } from '@/services/usageLimitsService';

/**
 * Find a user by email (unique). Returns the user with profile relations
 * pre-loaded, or null if no row matches. The returned object includes the
 * `deleted` flag — callers must check it to know whether the account is
 * archived (soft-deleted) and should trigger an in-place recreate.
 */
export async function findUserByEmail(db: PrismaClient, email: string) {
    return db.user.findUnique({
        where: { email },
        include: profileInclude
    });
}

/**
 * Recreate an account in-place after self-deletion.
 *
 * Reuses the existing user row (same `id` + `email`) and:
 *  - wipes all user-owned social/profile data (profile, settings, photos,
 *    tags, matches, blocks, conversations, messages, notifications, badges,
 *    activity participations/opens/hosted/reports, subscription, boosts,
 *    quotas, feedback);
 *  - PRESERVES evidence-grade rows (`IpLog`, `AuditLog`, sent/received
 *    `Report`, `SuspiciousActivity`);
 *  - invalidates every existing `Device` (rotates session hash, clears mail
 *    + push tokens, status back to `pending`) so old clients can't resume;
 *  - resets the user columns (name, demographics, flags) and stamps
 *    `recreatedAt` to mark the recreation;
 *  - creates a fresh `Profile` and the three daily quota rows so the user
 *    is in the same shape as a fresh signup.
 *
 * The caller is expected to link the current device + send the confirmation
 * email (same flow as a brand-new signup) after this resolves.
 */
export async function recreateUser(db: PrismaClient, userId: string, username: string): Promise<void> {
    const limits = await getUsageLimitConfig();
    const nextMidnight = new Date();
    nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
    nextMidnight.setUTCHours(0, 0, 0, 0);

    await db.$transaction(async (tx) => {
        // ── Wipe per-user data ──────────────────────────────────────
        await tx.userBadge.deleteMany({ where: { userId } });
        await tx.notification.deleteMany({ where: { userId } });
        await tx.message.deleteMany({ where: { senderId: userId } });
        await tx.conversationParticipant.deleteMany({ where: { userId } });
        await tx.match.deleteMany({
            where: { OR: [{ senderId: userId }, { receiverId: userId }] }
        });
        await tx.block.deleteMany({
            where: { OR: [{ blockerId: userId }, { blockedId: userId }] }
        });
        await tx.activityParticipant.deleteMany({ where: { userId } });
        await tx.activityOpen.deleteMany({ where: { userId } });
        await tx.activityReport.deleteMany({ where: { reporterId: userId } });
        await tx.activity.deleteMany({ where: { hostId: userId } });
        await tx.subscription.deleteMany({ where: { userId } });
        await tx.premiumOverride.deleteMany({ where: { userId } });
        await tx.activeBoost.deleteMany({ where: { userId } });
        await tx.searchQuota.deleteMany({ where: { userId } });
        await tx.swipeQuota.deleteMany({ where: { userId } });
        await tx.activityQuota.deleteMany({ where: { userId } });
        await tx.feedback.deleteMany({ where: { userId } });
        await tx.profilePhoto.deleteMany({ where: { userId } });
        await tx.userTag.deleteMany({ where: { userId } });
        await tx.profile.deleteMany({ where: { userId } });
        await tx.settings.deleteMany({ where: { userId } });

        // ── Invalidate old devices (kept for IpLog integrity) ───────
        const oldDevices = await tx.device.findMany({
            where: { userId },
            select: { id: true }
        });
        for (const d of oldDevices) {
            await tx.device.update({
                where: { id: d.id },
                data: {
                    sessionTokenHash: tokenManager.hashToken(tokenManager.session.generate()),
                    mailTokenHash: null,
                    status: 'pending',
                    pushToken: null,
                    pushProvider: null
                }
            });
        }

        // ── Reset user columns (preserve id, email, createdAt, bot) ─
        await tx.user.update({
            where: { id: userId },
            data: {
                name: username,
                birthDate: null,
                birthDateLastChangedAt: null,
                underageDeclared: false,
                gender: '',
                city: '',
                verified: false,
                banned: false,
                suspended: false,
                suspendedAt: null,
                deleted: false,
                deletedAt: null,
                appealMessage: null,
                appealRequestedAt: null,
                preferredPeriod: 'any',
                recreatedAt: new Date()
            }
        });

        // ── Fresh profile + quotas (parity with signup) ─────────────
        await tx.profile.create({ data: { userId, spokenLanguages: ['fr'] } });
        await tx.searchQuota.create({
            data: { userId, remaining: limits.initialSearchTokens, resetAt: nextMidnight }
        });
        await tx.swipeQuota.create({
            data: { userId, remaining: limits.swipeDailyFree, resetAt: nextMidnight }
        });
        await tx.activityQuota.create({
            data: { userId, remaining: limits.activityOpenDailyFree, resetAt: nextMidnight }
        });
    });
}
