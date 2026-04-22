import type { ActivitySummary, ActivitySearchFilters, InterestCategoryKey, Gender } from '@oxyfoo/whymeet-types';
import type { Prisma } from '@prisma/client';
import { getDatabase } from '@/services/database';
import { getDistanceKm, geoBoundingBox } from '@/services/userMapper';
import { INTEREST_CATEGORY_KEYS } from '@oxyfoo/whymeet-types';

interface ViewerContext {
    latitude: number | null;
    longitude: number | null;
    gender: string | null;
    activityGenders: string[];
    activityMaxDistance: number;
    activityRemoteMode: boolean;
    activityVerified: boolean;
    activityLanguages: string[];
}

async function loadViewerContext(userId: string): Promise<ViewerContext> {
    const db = getDatabase();
    const [user, settings] = await Promise.all([
        db.user.findUnique({
            where: { id: userId },
            select: { gender: true, profile: { select: { latitude: true, longitude: true } } }
        }),
        db.settings.findUnique({ where: { userId } })
    ]);

    return {
        latitude: user?.profile?.latitude ?? null,
        longitude: user?.profile?.longitude ?? null,
        gender: user?.gender ?? null,
        activityGenders: settings?.activityGenders ?? [],
        activityMaxDistance: settings?.activityMaxDistance ?? 50,
        activityRemoteMode: settings?.activityRemoteMode ?? false,
        activityVerified: settings?.activityVerified ?? false,
        activityLanguages: settings?.activityLanguages ?? []
    };
}

function buildHostWhere(viewer: ViewerContext): Prisma.UserWhereInput {
    const hostWhere: Prisma.UserWhereInput = {
        banned: false,
        suspended: false,
        deleted: false
    };
    if (viewer.activityGenders.length > 0) {
        hostWhere.gender = { in: viewer.activityGenders };
    }
    if (viewer.activityVerified) {
        hostWhere.verified = true;
    }
    if (viewer.activityLanguages.length > 0) {
        hostWhere.profile = { spokenLanguages: { hasSome: viewer.activityLanguages } };
    }
    return hostWhere;
}

// ─── Get Activities ──────────────────────────────────────────────────

export async function getActivities(
    userId: string,
    filters?: ActivitySearchFilters
): Promise<{ activities: ActivitySummary[]; totalCount: number }> {
    const db = getDatabase();
    const viewer = await loadViewerContext(userId);

    // Get reported activity IDs by this user (to exclude)
    const reportedIds = (
        await db.activityReport.findMany({
            where: { reporterId: userId },
            select: { activityId: true }
        })
    ).map((r) => r.activityId);

    // Resolve effective distance filter: explicit filters override viewer prefs
    const effectiveMaxDistance =
        filters?.maxDistance ?? (viewer.activityRemoteMode ? undefined : viewer.activityMaxDistance);

    const where: Prisma.ActivityWhereInput = {
        isCancelled: false,
        isArchived: false,
        id: reportedIds.length > 0 ? { notIn: reportedIds } : undefined,
        host: buildHostWhere(viewer),
        // My gender must be accepted by the activity's target audience
        ...(viewer.gender ? { targetGenders: { has: viewer.gender } } : {})
    };

    if (filters?.category) {
        where.category = filters.category;
    }

    if (filters?.dateFrom || filters?.dateTo) {
        where.dateTime = {};
        if (filters.dateFrom) where.dateTime.gte = new Date(filters.dateFrom);
        if (filters.dateTo) where.dateTime.lte = new Date(filters.dateTo);
    }

    if (filters?.query) {
        where.OR = [
            { title: { contains: filters.query, mode: 'insensitive' } },
            { description: { contains: filters.query, mode: 'insensitive' } }
        ];
    }

    // Tag filter: match against host's interest tags
    if (filters?.tags && filters.tags.length > 0) {
        const hostAnd: Prisma.UserWhereInput = {
            tags: {
                some: {
                    type: 'interest',
                    tag: { label: { in: filters.tags } }
                }
            }
        };
        where.host = { ...(where.host as Prisma.UserWhereInput), ...hostAnd };
    }

    // Geo bounding box filter
    if (effectiveMaxDistance && viewer.latitude != null && viewer.longitude != null) {
        const bbox = geoBoundingBox(viewer.latitude, viewer.longitude, effectiveMaxDistance);
        if (bbox) {
            where.latitude = bbox.latitude;
            where.longitude = bbox.longitude;
        }
    }

    const activities = await db.activity.findMany({
        where,
        include: {
            host: { select: { name: true } },
            participants: { select: { userId: true } },
            photos: { orderBy: { position: 'asc' }, take: 1 }
        },
        orderBy: [{ dateTime: 'asc' }, { createdAt: 'desc' }],
        take: 50
    });

    // Post-filter by exact distance if needed
    let filtered = activities;
    if (effectiveMaxDistance && viewer.latitude != null && viewer.longitude != null) {
        filtered = activities.filter((a) => {
            if (a.latitude == null || a.longitude == null) return true; // no location = include
            const dist = getDistanceKm(viewer.latitude, viewer.longitude, a.latitude, a.longitude);
            return dist != null && dist <= effectiveMaxDistance;
        });
    }

    const summaries: ActivitySummary[] = filtered.map((a) => {
        const distKm = getDistanceKm(viewer.latitude, viewer.longitude, a.latitude, a.longitude);
        const distStr = distKm != null ? (distKm < 1 ? '< 1 km' : `${Math.round(distKm)} km`) : undefined;

        return {
            id: a.id,
            title: a.title,
            category: a.category as InterestCategoryKey,
            dateTime: a.dateTime?.toISOString() ?? null,
            locationName: a.locationName,
            participantCount: a.participants.length,
            maxParticipants: a.maxParticipants,
            photoKey: a.photos[0]?.key ?? null,
            hostName: a.host.name,
            targetGenders: a.targetGenders as Gender[],
            distance: distStr,
            distanceKm: distKm ?? undefined
        };
    });

    return { activities: summaries, totalCount: summaries.length };
}

// ─── Get Activity Counts ────────────────────────────────────────────

export async function getActivityCounts(userId: string): Promise<Record<string, number>> {
    const db = getDatabase();
    const viewer = await loadViewerContext(userId);

    // Get reported activity IDs by this user
    const reportedIds = (
        await db.activityReport.findMany({
            where: { reporterId: userId },
            select: { activityId: true }
        })
    ).map((r) => r.activityId);

    const baseWhere: Prisma.ActivityWhereInput = {
        isCancelled: false,
        isArchived: false,
        host: buildHostWhere(viewer),
        ...(viewer.gender ? { targetGenders: { has: viewer.gender } } : {})
    };
    if (reportedIds.length > 0) {
        baseWhere.id = { notIn: reportedIds };
    }

    const counts: Record<string, number> = {};
    for (const key of INTEREST_CATEGORY_KEYS) {
        counts[key] = await db.activity.count({
            where: { ...baseWhere, category: key }
        });
    }

    return counts;
}

// ─── Search Activities ──────────────────────────────────────────────

export async function searchActivities(
    userId: string,
    filters: ActivitySearchFilters
): Promise<{ activities: ActivitySummary[]; totalCount: number }> {
    // Search reuses getActivities with the filters
    return getActivities(userId, filters);
}

// ─── Get Popular Activity Tags ──────────────────────────────────────

export async function getPopularActivityTags(userId: string, category: InterestCategoryKey): Promise<string[]> {
    const db = getDatabase();
    const viewer = await loadViewerContext(userId);

    const reportedIds = (
        await db.activityReport.findMany({
            where: { reporterId: userId },
            select: { activityId: true }
        })
    ).map((r) => r.activityId);

    // Aggregate tags from hosts of matching activities
    const activities = await db.activity.findMany({
        where: {
            category,
            isCancelled: false,
            isArchived: false,
            host: buildHostWhere(viewer),
            ...(viewer.gender ? { targetGenders: { has: viewer.gender } } : {}),
            ...(reportedIds.length > 0 ? { id: { notIn: reportedIds } } : {})
        },
        select: {
            host: {
                select: {
                    tags: {
                        where: { type: 'interest' },
                        select: { tag: { select: { label: true } } }
                    }
                }
            }
        },
        take: 200
    });

    const counts = new Map<string, number>();
    for (const a of activities) {
        for (const t of a.host.tags) {
            counts.set(t.tag.label, (counts.get(t.tag.label) ?? 0) + 1);
        }
    }

    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([label]) => label);
}

// ─── Get My Activities ──────────────────────────────────────────────

export async function getMyActivities(userId: string, role: 'host' | 'participant'): Promise<ActivitySummary[]> {
    const db = getDatabase();

    const viewerProfile = await db.profile.findUnique({
        where: { userId },
        select: { latitude: true, longitude: true }
    });

    const where: Prisma.ActivityWhereInput = {
        isCancelled: false,
        isArchived: false,
        ...(role === 'host' ? { hostId: userId } : { participants: { some: { userId } } })
    };

    const activities = await db.activity.findMany({
        where,
        include: {
            host: { select: { name: true } },
            participants: { select: { userId: true } },
            photos: { orderBy: { position: 'asc' }, take: 1 }
        },
        orderBy: [{ dateTime: 'asc' }, { createdAt: 'desc' }],
        take: 50
    });

    return activities.map((a) => {
        const distKm = getDistanceKm(viewerProfile?.latitude, viewerProfile?.longitude, a.latitude, a.longitude);
        const distStr = distKm != null ? (distKm < 1 ? '< 1 km' : `${Math.round(distKm)} km`) : undefined;

        return {
            id: a.id,
            title: a.title,
            category: a.category as InterestCategoryKey,
            dateTime: a.dateTime?.toISOString() ?? null,
            locationName: a.locationName,
            participantCount: a.participants.length,
            maxParticipants: a.maxParticipants,
            photoKey: a.photos[0]?.key ?? null,
            hostName: a.host.name,
            targetGenders: a.targetGenders as Gender[],
            distance: distStr,
            distanceKm: distKm ?? undefined
        };
    });
}
