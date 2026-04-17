import type {
    Activity,
    ActivityPhoto,
    InterestCategoryKey,
    User,
    Gender,
    PreferredPeriod,
    ProfilePhoto
} from '@oxyfoo/whymeet-types';
import type { Prisma } from '@prisma/client';
import { getDatabase } from '@/services/database';
import { getDistanceKm } from '@/services/userMapper';
import { computeAge } from '@/services/userMapper';
import { discretizePosition } from '@/services/geoUtils';
import { logger } from '@/config/logger';

const ACTIVITY_ARCHIVE_THRESHOLD = 4;

type UserWithPhotos = Prisma.UserGetPayload<{ include: { photos: true } }>;

// ─── Helpers ─────────────────────────────────────────────────────────

function mapPrismaUserToUser(u: UserWithPhotos): User {
    return {
        id: u.id,
        name: u.name,
        age: computeAge(u.birthDate),
        birthDate: u.birthDate?.toISOString() ?? null,
        gender: (u.gender || 'male') as Gender,
        photos: (u.photos ?? []).map((p) => ({
            id: p.id,
            key: p.key,
            description: p.description,
            position: p.position
        })) as ProfilePhoto[],
        city: u.city,
        verified: u.verified,
        suspended: u.suspended ?? false,
        banned: u.banned ?? false,
        preferredPeriod: (u.preferredPeriod ?? 'any') as PreferredPeriod,
        isPremium: false,
        isBoosted: false
    };
}

interface PrismaActivityWithRelations {
    id: string;
    hostId: string;
    host: Parameters<typeof mapPrismaUserToUser>[0];
    title: string;
    description: string;
    category: string;
    dateTime: Date | null;
    locationName: string;
    latitude: number | null;
    longitude: number | null;
    maxParticipants: number | null;
    conversationId: string | null;
    isCancelled: boolean;
    isArchived: boolean;
    participants: { userId: string; user: Parameters<typeof mapPrismaUserToUser>[0] }[];
    photos: { id: string; key: string; position: number }[];
    createdAt: Date;
    updatedAt: Date;
}

function mapToActivity(
    a: PrismaActivityWithRelations,
    viewerId: string,
    viewerLat?: number | null,
    viewerLng?: number | null
): Activity {
    const distKm = getDistanceKm(viewerLat, viewerLng, a.latitude, a.longitude);
    const distStr = distKm != null ? (distKm < 1 ? '< 1 km' : `${Math.round(distKm)} km`) : undefined;

    return {
        id: a.id,
        host: mapPrismaUserToUser(a.host),
        title: a.title,
        description: a.description,
        category: a.category as InterestCategoryKey,
        dateTime: a.dateTime?.toISOString() ?? null,
        locationName: a.locationName,
        latitude: a.latitude,
        longitude: a.longitude,
        maxParticipants: a.maxParticipants,
        participantCount: a.participants?.length ?? 0,
        participants: (a.participants ?? []).map((p: { user: Parameters<typeof mapPrismaUserToUser>[0] }) =>
            mapPrismaUserToUser(p.user)
        ),
        photos: (a.photos ?? []).map(
            (p: { id: string; key: string; position: number }): ActivityPhoto => ({
                id: p.id,
                key: p.key,
                position: p.position
            })
        ),
        conversationId: a.conversationId,
        isCancelled: a.isCancelled,
        isArchived: a.isArchived,
        isParticipant: (a.participants ?? []).some((p: { userId: string }) => p.userId === viewerId),
        isHost: a.hostId === viewerId,
        distance: distStr,
        distanceKm: distKm ?? undefined,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString()
    };
}

const activityInclude = {
    host: { include: { photos: { orderBy: { position: 'asc' as const } } } },
    participants: {
        include: {
            user: { include: { photos: { orderBy: { position: 'asc' as const } } } }
        }
    },
    photos: { orderBy: { position: 'asc' as const } }
} as const;

// ─── Create ──────────────────────────────────────────────────────────

export async function createActivity(
    hostId: string,
    data: {
        title: string;
        description: string;
        category: string;
        dateTime?: string;
        locationName: string;
        latitude?: number;
        longitude?: number;
        maxParticipants?: number;
    }
): Promise<Activity> {
    const db = getDatabase();

    // Discretize position if provided
    let lat = data.latitude ?? null;
    let lng = data.longitude ?? null;
    if (lat != null && lng != null) {
        const disc = discretizePosition(lat, lng);
        lat = disc.latitude;
        lng = disc.longitude;
    }

    // Create conversation for the activity (group chat)
    const conversation = await db.conversation.create({
        data: {
            isGroup: true,
            participants: {
                create: { userId: hostId }
            }
        }
    });

    // Create activity
    const activity = await db.activity.create({
        data: {
            hostId,
            title: data.title,
            description: data.description,
            category: data.category,
            dateTime: data.dateTime ? new Date(data.dateTime) : null,
            locationName: data.locationName,
            latitude: lat,
            longitude: lng,
            maxParticipants: data.maxParticipants ?? null,
            conversationId: conversation.id,
            participants: {
                create: { userId: hostId }
            }
        },
        include: activityInclude
    });

    // Schedule notifications if dateTime is set
    if (activity.dateTime) {
        await scheduleActivityNotifs(activity.id, activity.dateTime);
    }

    // Get viewer location for distance
    const hostProfile = await db.profile.findUnique({
        where: { userId: hostId },
        select: { latitude: true, longitude: true }
    });

    return mapToActivity(activity, hostId, hostProfile?.latitude, hostProfile?.longitude);
}

// ─── Update ──────────────────────────────────────────────────────────

export async function updateActivity(
    activityId: string,
    hostId: string,
    data: {
        title?: string;
        description?: string;
        category?: string;
        dateTime?: string | null;
        locationName?: string;
        latitude?: number | null;
        longitude?: number | null;
        maxParticipants?: number | null;
    }
): Promise<Activity | null> {
    const db = getDatabase();

    const existing = await db.activity.findUnique({ where: { id: activityId } });
    if (!existing || existing.hostId !== hostId) return null;
    if (existing.isCancelled || existing.isArchived) return null;

    // Discretize position if provided
    let lat = data.latitude;
    let lng = data.longitude;
    if (lat != null && lng != null) {
        const disc = discretizePosition(lat, lng);
        lat = disc.latitude;
        lng = disc.longitude;
    }

    const updateData: Prisma.ActivityUpdateInput = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.locationName !== undefined) updateData.locationName = data.locationName;
    if (data.latitude !== undefined) updateData.latitude = lat;
    if (data.longitude !== undefined) updateData.longitude = lng;
    if (data.maxParticipants !== undefined) updateData.maxParticipants = data.maxParticipants;

    if (data.dateTime !== undefined) {
        updateData.dateTime = data.dateTime ? new Date(data.dateTime) : null;
    }

    const activity = await db.activity.update({
        where: { id: activityId },
        data: updateData,
        include: activityInclude
    });

    // Reschedule notifications if dateTime changed
    if (data.dateTime !== undefined) {
        if (activity.dateTime) {
            await scheduleActivityNotifs(activity.id, activity.dateTime);
        } else {
            // Remove scheduled notifs if dateTime cleared
            await db.activityScheduledNotif.deleteMany({ where: { activityId } });
        }
    }

    const hostProfile = await db.profile.findUnique({
        where: { userId: hostId },
        select: { latitude: true, longitude: true }
    });

    return mapToActivity(activity, hostId, hostProfile?.latitude, hostProfile?.longitude);
}

// ─── Cancel ──────────────────────────────────────────────────────────

export async function cancelActivity(activityId: string, hostId: string): Promise<boolean> {
    const db = getDatabase();

    const existing = await db.activity.findUnique({ where: { id: activityId } });
    if (!existing || existing.hostId !== hostId) return false;
    if (existing.isCancelled) return false;

    await db.activity.update({
        where: { id: activityId },
        data: { isCancelled: true }
    });

    // Remove scheduled notifications
    await db.activityScheduledNotif.deleteMany({ where: { activityId } });

    logger.info(`[Activity] Activity ${activityId} cancelled by host ${hostId}`);
    return true;
}

// ─── Get ─────────────────────────────────────────────────────────────

export async function getActivity(activityId: string, viewerId: string): Promise<Activity | null> {
    const db = getDatabase();

    const activity = await db.activity.findUnique({
        where: { id: activityId },
        include: activityInclude
    });

    if (!activity) return null;

    const viewerProfile = await db.profile.findUnique({
        where: { userId: viewerId },
        select: { latitude: true, longitude: true }
    });

    return mapToActivity(activity, viewerId, viewerProfile?.latitude, viewerProfile?.longitude);
}

// ─── Join ────────────────────────────────────────────────────────────

export async function joinActivity(
    activityId: string,
    userId: string
): Promise<{ activity: Activity; conversationId: string } | { error: string }> {
    const db = getDatabase();

    const activity = await db.activity.findUnique({
        where: { id: activityId },
        include: { participants: true }
    });

    if (!activity) return { error: 'Activity not found' };
    if (activity.isCancelled) return { error: 'Activity is cancelled' };
    if (activity.isArchived) return { error: 'Activity is archived' };

    // Check already a participant
    if (activity.participants.some((p) => p.userId === userId)) {
        return { error: 'Already a participant' };
    }

    // Check max participants
    if (activity.maxParticipants != null && activity.participants.length >= activity.maxParticipants) {
        return { error: 'Activity is full' };
    }

    // Check if user has reported this activity
    const reported = await db.activityReport.findUnique({
        where: { reporterId_activityId: { reporterId: userId, activityId } }
    });
    if (reported) return { error: 'Cannot join a reported activity' };

    // Add participant
    await db.activityParticipant.create({
        data: { activityId, userId }
    });

    // Add to group conversation
    if (activity.conversationId) {
        await db.conversationParticipant.upsert({
            where: {
                conversationId_userId: { conversationId: activity.conversationId, userId }
            },
            create: { conversationId: activity.conversationId, userId },
            update: {}
        });
    }

    // Fetch full activity
    const fullActivity = await db.activity.findUnique({
        where: { id: activityId },
        include: activityInclude
    });

    const viewerProfile = await db.profile.findUnique({
        where: { userId },
        select: { latitude: true, longitude: true }
    });

    return {
        activity: mapToActivity(fullActivity!, userId, viewerProfile?.latitude, viewerProfile?.longitude),
        conversationId: activity.conversationId!
    };
}

// ─── Leave ───────────────────────────────────────────────────────────

export async function leaveActivity(activityId: string, userId: string): Promise<{ error?: string }> {
    const db = getDatabase();

    const activity = await db.activity.findUnique({ where: { id: activityId } });
    if (!activity) return { error: 'Activity not found' };
    if (activity.hostId === userId) return { error: 'Host cannot leave their own activity' };

    // Check membership
    const participation = await db.activityParticipant.findUnique({
        where: { activityId_userId: { activityId, userId } }
    });
    if (!participation) return { error: 'Not a participant' };

    // Remove participant
    await db.activityParticipant.delete({
        where: { activityId_userId: { activityId, userId } }
    });

    // Remove from group conversation
    if (activity.conversationId) {
        await db.conversationParticipant.deleteMany({
            where: { conversationId: activity.conversationId, userId }
        });
    }

    return {};
}

// ─── Report ──────────────────────────────────────────────────────────

export async function reportActivity(
    activityId: string,
    reporterId: string,
    reason: string,
    message?: string
): Promise<{ error?: string }> {
    const db = getDatabase();

    const activity = await db.activity.findUnique({ where: { id: activityId } });
    if (!activity) return { error: 'Activity not found' };
    if (activity.hostId === reporterId) return { error: 'Cannot report your own activity' };

    if (message && message.length > 500) return { error: 'Message too long (500 max)' };

    await db.activityReport.upsert({
        where: {
            reporterId_activityId: { reporterId, activityId }
        },
        create: {
            reporterId,
            activityId,
            reason,
            message: message ?? ''
        },
        update: {
            reason,
            message: message ?? '',
            status: 'pending'
        }
    });

    logger.info(`[Activity] User ${reporterId} reported activity ${activityId} (${reason})`);

    // Auto-archive if threshold reached
    const reportCount = await db.activityReport.count({ where: { activityId } });
    if (reportCount >= ACTIVITY_ARCHIVE_THRESHOLD && !activity.isArchived) {
        await db.activity.update({
            where: { id: activityId },
            data: { isArchived: true }
        });
        logger.warn(`[Activity] Activity ${activityId} auto-archived (${reportCount} reports)`);
    }

    return {};
}

// ─── Schedule Notifications ──────────────────────────────────────────

async function scheduleActivityNotifs(activityId: string, dateTime: Date): Promise<void> {
    const db = getDatabase();
    const now = new Date();

    const h24Before = new Date(dateTime.getTime() - 24 * 60 * 60 * 1000);
    const h1Before = new Date(dateTime.getTime() - 1 * 60 * 60 * 1000);

    // Only schedule if in the future
    if (h24Before > now) {
        await db.activityScheduledNotif.upsert({
            where: { activityId_type: { activityId, type: '24h' } },
            create: { activityId, type: '24h', scheduledAt: h24Before },
            update: { scheduledAt: h24Before, sent: false, sentAt: null }
        });
    }

    if (h1Before > now) {
        await db.activityScheduledNotif.upsert({
            where: { activityId_type: { activityId, type: '1h' } },
            create: { activityId, type: '1h', scheduledAt: h1Before },
            update: { scheduledAt: h1Before, sent: false, sentAt: null }
        });
    }
}
