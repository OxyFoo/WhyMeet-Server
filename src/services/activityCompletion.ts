/**
 * Activity completion checks (server-side).
 *
 * Mirrors the client-side rules in
 * `WhyMeet/src/features/activity/utils/computeActivityCompletion.ts`.
 *
 * Used by `updateActivity` to refuse a regression from complete → incomplete,
 * analogous to `profileCompletion.isProfileComplete`.
 */

export const ACTIVITY_TITLE_MIN = 3;

interface ActivityForCompletion {
    title: string;
    category: string | null;
    dateTime: Date | null;
    locationName: string | null;
    photos: { id: string }[];
}

export function isActivityComplete(activity: ActivityForCompletion): boolean {
    return (
        (activity.photos?.length ?? 0) > 0 &&
        typeof activity.title === 'string' &&
        activity.title.trim().length >= ACTIVITY_TITLE_MIN &&
        !!activity.category &&
        activity.dateTime !== null &&
        !!activity.locationName
    );
}

export class ActivityWouldBecomeIncompleteError extends Error {
    constructor() {
        super('activityWouldBecomeIncomplete');
        this.name = 'ActivityWouldBecomeIncompleteError';
    }
}
