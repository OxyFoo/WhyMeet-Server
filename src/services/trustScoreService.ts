import { getHostLevel, type HostLevel } from '@oxyfoo/whymeet-types';
import { getDatabase } from '@/services/database';
import { checkAndAwardBadges } from '@/services/badgeService';
import { logger } from '@/config/logger';

const CONFIRMATION_WINDOW_DAYS = 7;
const COMPLETION_PARTICIPANT_THRESHOLD_PERCENT = 0.3; // 30% of host-reported attendees
const COMPLETION_SELF_REPORT_PERCENT = 0.5; // 50% of registered participants
const COMPLETION_SELF_REPORT_MIN = 4; // minimum 4 self-confirmations

/**
 * Recalculate and persist the trust score for a user (as host).
 * Formula:
 *   baseScore = min(completedCount * 2, 40)
 *   attendanceScore = avgAttendanceRatio * 35
 *   trustScore = clamp(baseScore + attendanceScore + 25 - reportPenalty - cancellationPenalty, 0, 100)
 */
export async function recalculateTrustScore(userId: string): Promise<number> {
    const db = getDatabase();

    const profile = await db.profile.findUnique({
        where: { userId },
        select: { completedHostedCount: true, cancelledHostedCount: true }
    });

    if (!profile) return 0;

    const completedCount = profile.completedHostedCount;
    const cancellations = profile.cancelledHostedCount;

    // Base score from completed activities
    const baseScore = Math.min(completedCount * 2, 40);

    // Attendance score: average ratio of confirmed / expected across completed activities
    const completedActivities = await db.activity.findMany({
        where: { hostId: userId, isCompleted: true },
        select: {
            hostReportedAttendees: true,
            participants: { select: { confirmedAttendance: true } }
        }
    });

    let attendanceScore = 0;
    if (completedActivities.length > 0) {
        let totalRatio = 0;
        for (const act of completedActivities) {
            const expected = act.participants.length;
            const actual =
                act.hostReportedAttendees ?? act.participants.filter((p) => p.confirmedAttendance === true).length;
            if (expected > 0) {
                totalRatio += Math.min(actual / expected, 1);
            }
        }
        attendanceScore = (totalRatio / completedActivities.length) * 35;
    }

    // Report penalty (only legitimate reports)
    const legitimateReports = await db.activityReport.count({
        where: {
            activity: { hostId: userId },
            isLegitimate: true
        }
    });
    const reportPenalty = legitimateReports * 8;
    const cancellationPenalty = cancellations * 4;

    const trustScore = Math.max(
        0,
        Math.min(100, Math.round(baseScore + attendanceScore + 25 - reportPenalty - cancellationPenalty))
    );

    await db.profile.update({
        where: { userId },
        data: { trustScore }
    });

    logger.info(
        `[TrustScore] User ${userId}: score=${trustScore} (base=${baseScore}, att=${attendanceScore.toFixed(1)}, rep=-${reportPenalty}, cancel=-${cancellationPenalty})`
    );

    return trustScore;
}

/**
 * Get the host level for a user based on their trust score and completed count.
 */
export async function getUserHostLevel(userId: string): Promise<HostLevel | null> {
    const db = getDatabase();
    const profile = await db.profile.findUnique({
        where: { userId },
        select: { trustScore: true, completedHostedCount: true }
    });
    if (!profile) return null;
    return getHostLevel(profile.trustScore, profile.completedHostedCount);
}

/**
 * Host confirms attendance for an activity.
 * Validates host ownership, time window, and stores the count.
 */
export async function confirmActivityAsHost(
    activityId: string,
    hostId: string,
    attendeeCount: number,
    absentUserIds?: string[]
): Promise<{ error?: string }> {
    const db = getDatabase();

    const activity = await db.activity.findUnique({
        where: { id: activityId },
        include: { participants: true }
    });

    if (!activity) return { error: 'Activity not found' };
    if (activity.hostId !== hostId) return { error: 'Only the host can confirm attendance' };
    if (activity.isCancelled) return { error: 'Activity is cancelled' };
    if (activity.hostConfirmedAt) return { error: 'Already confirmed' };

    if (!activity.dateTime) return { error: 'Activity has no date' };
    const deadline = new Date(activity.dateTime.getTime() + CONFIRMATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    if (new Date() > deadline) return { error: 'Confirmation window expired (7 days)' };
    if (new Date() < activity.dateTime) return { error: 'Activity has not started yet' };

    // Clamp attendeeCount
    const clampedCount = Math.max(0, Math.min(attendeeCount, activity.participants.length));

    await db.activity.update({
        where: { id: activityId },
        data: {
            hostConfirmedAt: new Date(),
            hostReportedAttendees: clampedCount
        }
    });

    // Mark absent users if provided
    if (absentUserIds && absentUserIds.length > 0) {
        for (const uid of absentUserIds) {
            await db.activityParticipant.updateMany({
                where: { activityId, userId: uid },
                data: { confirmedAttendance: false }
            });
        }
    }

    // Check if activity can be marked as completed
    await checkActivityCompletion(activityId);

    return {};
}

/**
 * Participant confirms their own attendance.
 */
export async function confirmParticipation(
    activityId: string,
    userId: string,
    attended: boolean
): Promise<{ error?: string }> {
    const db = getDatabase();

    const activity = await db.activity.findUnique({ where: { id: activityId } });
    if (!activity) return { error: 'Activity not found' };
    if (activity.isCancelled) return { error: 'Activity is cancelled' };

    if (!activity.dateTime) return { error: 'Activity has no date' };
    const deadline = new Date(activity.dateTime.getTime() + CONFIRMATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    if (new Date() > deadline) return { error: 'Confirmation window expired (7 days)' };
    if (new Date() < activity.dateTime) return { error: 'Activity has not started yet' };

    const participant = await db.activityParticipant.findUnique({
        where: { activityId_userId: { activityId, userId } }
    });
    if (!participant) return { error: 'Not a participant' };
    if (participant.confirmedAttendance !== null) return { error: 'Already confirmed' };

    await db.activityParticipant.update({
        where: { activityId_userId: { activityId, userId } },
        data: { confirmedAttendance: attended }
    });

    await checkActivityCompletion(activityId);

    return {};
}

/**
 * Check if an activity meets the completion criteria and mark it accordingly.
 *
 * Completed if dateTime passed AND not cancelled AND:
 * - (host confirmed AND >= 30% of host-reported attendees confirmed) OR
 * - (>= 50% of registered participants self-confirmed AND >= 4 confirmations)
 */
export async function checkActivityCompletion(activityId: string): Promise<void> {
    const db = getDatabase();

    const activity = await db.activity.findUnique({
        where: { id: activityId },
        include: { participants: true }
    });

    if (!activity || activity.isCompleted || activity.isCancelled) return;
    if (!activity.dateTime || new Date() < activity.dateTime) return;

    const totalParticipants = activity.participants.length;
    const confirmedTrue = activity.participants.filter((p) => p.confirmedAttendance === true).length;

    let completed = false;

    // Path 1: Host confirmed + >= 30% of host-reported attendees validated
    if (activity.hostConfirmedAt && activity.hostReportedAttendees != null) {
        const threshold = Math.ceil(activity.hostReportedAttendees * COMPLETION_PARTICIPANT_THRESHOLD_PERCENT);
        if (confirmedTrue >= threshold) {
            completed = true;
        }
    }

    // Path 2: >= 50% of registered participants self-confirmed + >= 4
    if (!completed && totalParticipants > 0) {
        const threshold = Math.ceil(totalParticipants * COMPLETION_SELF_REPORT_PERCENT);
        if (confirmedTrue >= threshold && confirmedTrue >= COMPLETION_SELF_REPORT_MIN) {
            completed = true;
        }
    }

    if (completed) {
        await db.activity.update({
            where: { id: activityId },
            data: { isCompleted: true }
        });

        // Update host profile stats
        await db.profile.update({
            where: { userId: activity.hostId },
            data: { completedHostedCount: { increment: 1 } }
        });

        // Recalculate trust score
        await recalculateTrustScore(activity.hostId);

        // Award badges for host and participants
        await checkAndAwardBadges(activity.hostId);
        for (const p of activity.participants) {
            if (p.userId !== activity.hostId) {
                await checkAndAwardBadges(p.userId);
            }
        }

        logger.info(`[TrustScore] Activity ${activityId} marked as completed`);
    }
}
