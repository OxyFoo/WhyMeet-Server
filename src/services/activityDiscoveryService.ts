import type { ActivitySummary, ActivitySearchFilters, InterestCategoryKey } from '@oxyfoo/whymeet-types';
import type { Prisma } from '@prisma/client';
import { getDatabase } from '@/services/database';
import { getDistanceKm, geoBoundingBox } from '@/services/userMapper';
import { INTEREST_CATEGORY_KEYS } from '@oxyfoo/whymeet-types';

// ─── Get Activities ──────────────────────────────────────────────────

export async function getActivities(
    userId: string,
    filters?: ActivitySearchFilters
): Promise<{ activities: ActivitySummary[]; totalCount: number }> {
    const db = getDatabase();

    // Get viewer location
    const viewerProfile = await db.profile.findUnique({
        where: { userId },
        select: { latitude: true, longitude: true }
    });

    // Get reported activity IDs by this user (to exclude)
    const reportedIds = (
        await db.activityReport.findMany({
            where: { reporterId: userId },
            select: { activityId: true }
        })
    ).map((r) => r.activityId);

    // Build where clause
    const where: Prisma.ActivityWhereInput = {
        isCancelled: false,
        isArchived: false,
        id: reportedIds.length > 0 ? { notIn: reportedIds } : undefined,
        host: { banned: false, suspended: false, deleted: false }
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

    // Geo bounding box filter
    if (filters?.maxDistance && viewerProfile?.latitude && viewerProfile?.longitude) {
        const bbox = geoBoundingBox(viewerProfile.latitude, viewerProfile.longitude, filters.maxDistance);
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
    if (filters?.maxDistance && viewerProfile?.latitude && viewerProfile?.longitude) {
        filtered = activities.filter((a) => {
            if (a.latitude == null || a.longitude == null) return true; // no location = include
            const dist = getDistanceKm(viewerProfile.latitude, viewerProfile.longitude, a.latitude, a.longitude);
            return dist != null && dist <= filters.maxDistance!;
        });
    }

    const summaries: ActivitySummary[] = filtered.map((a) => {
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
            distance: distStr,
            distanceKm: distKm ?? undefined
        };
    });

    return { activities: summaries, totalCount: summaries.length };
}

// ─── Get Activity Counts ────────────────────────────────────────────

export async function getActivityCounts(userId: string): Promise<Record<string, number>> {
    const db = getDatabase();

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
        host: { banned: false, suspended: false, deleted: false }
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
