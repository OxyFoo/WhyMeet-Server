/**
 * Centralized validation constants and Zod schemas for all server commands.
 * Import `LIMITS` for inline checks, or the Zod schemas for safeParse.
 */

import { z } from 'zod';
import { SOCIAL_VIBES, INTENTION_KEYS, INTEREST_CATEGORY_KEYS } from '@whymeet/types';

// ─── Limits ───────────────────────────────────────────────────────────────────

export const LIMITS = {
    NAME_MIN: 2,
    NAME_MAX: 50,
    BIO_MAX: 300,
    CITY_MAX: 100,
    MESSAGE_MAX: 1000,
    TAG_LABEL_MAX: 40,
    INTERESTS_MAX: 30,
    SKILLS_MAX: 30,
    LANGUAGES_MAX: 20,
    INTENTIONS_MAX: 7,
    PUSH_TOKEN_MAX: 300,
    LOCATION_NAME_MAX: 100,
    ACTIVITY_TITLE_MIN: 3,
    ACTIVITY_TITLE_MAX: 100,
    ACTIVITY_DESC_MAX: 2000,
    PARTICIPANTS_MIN: 2,
    PARTICIPANTS_MAX: 100,
    PHOTO_DESCRIPTION_MAX: 128
} as const;

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const sendMessageSchema = z.object({
    conversationId: z.string().min(1),
    text: z.string().min(1, 'Message cannot be empty').max(LIMITS.MESSAGE_MAX)
});

export const pushTokenSchema = z.object({
    token: z.string().min(1).max(LIMITS.PUSH_TOKEN_MAX),
    provider: z.literal('fcm')
});

export const createActivitySchema = z.object({
    title: z.string().trim().min(LIMITS.ACTIVITY_TITLE_MIN).max(LIMITS.ACTIVITY_TITLE_MAX),
    description: z.string().trim().max(LIMITS.ACTIVITY_DESC_MAX).optional(),
    category: z.enum(INTEREST_CATEGORY_KEYS as unknown as [string, ...string[]]),
    locationName: z.string().trim().max(LIMITS.LOCATION_NAME_MAX).optional(),
    maxParticipants: z.number().int().min(LIMITS.PARTICIPANTS_MIN).max(LIMITS.PARTICIPANTS_MAX).optional(),
    dateTime: z
        .string()
        .refine((d) => !isNaN(new Date(d).getTime()) && new Date(d) > new Date(), {
            message: 'dateTime must be a valid date in the future'
        })
        .optional()
});

export const updateActivitySchema = z.object({
    title: z.string().trim().min(LIMITS.ACTIVITY_TITLE_MIN).max(LIMITS.ACTIVITY_TITLE_MAX).optional(),
    description: z.string().trim().max(LIMITS.ACTIVITY_DESC_MAX).optional(),
    category: z.enum(INTEREST_CATEGORY_KEYS as unknown as [string, ...string[]]).optional(),
    locationName: z.string().trim().max(LIMITS.LOCATION_NAME_MAX).optional(),
    maxParticipants: z.number().int().min(LIMITS.PARTICIPANTS_MIN).max(LIMITS.PARTICIPANTS_MAX).optional(),
    dateTime: z
        .string()
        .refine((d) => !isNaN(new Date(d).getTime()) && new Date(d) > new Date(), {
            message: 'dateTime must be a valid date in the future'
        })
        .optional()
});

// ─── Inline helpers for update-profile ────────────────────────────────────────

/**
 * Validates the user-submitted profile data.
 * Returns null on success, or a human-readable error string.
 */
export function validateProfileData(data: Record<string, unknown>): string | null {
    if (data.name !== undefined) {
        if (typeof data.name !== 'string') return 'Invalid field: name';
        const trimmed = data.name.trim();
        if (trimmed.length < LIMITS.NAME_MIN || trimmed.length > LIMITS.NAME_MAX) {
            return 'Invalid field: name';
        }
    }
    if (data.bio !== undefined) {
        if (typeof data.bio !== 'string' || data.bio.length > LIMITS.BIO_MAX) {
            return 'Invalid field: bio';
        }
    }
    if (data.city !== undefined) {
        if (typeof data.city !== 'string' || data.city.trim().length > LIMITS.CITY_MAX) {
            return 'Invalid field: city';
        }
    }
    if (data.socialVibe !== undefined) {
        if (!(SOCIAL_VIBES as readonly string[]).includes(data.socialVibe as string)) {
            return 'Invalid field: socialVibe';
        }
    }
    if (data.intentions !== undefined) {
        if (
            !Array.isArray(data.intentions) ||
            data.intentions.length > LIMITS.INTENTIONS_MAX ||
            data.intentions.some((i) => !(INTENTION_KEYS as readonly string[]).includes(i as string))
        ) {
            return 'Invalid field: intentions';
        }
    }
    if (data.spokenLanguages !== undefined) {
        if (
            !Array.isArray(data.spokenLanguages) ||
            data.spokenLanguages.length > LIMITS.LANGUAGES_MAX ||
            data.spokenLanguages.some((l) => typeof l !== 'string' || l.length === 0)
        ) {
            return 'Invalid field: spokenLanguages';
        }
    }
    if (data.interests !== undefined) {
        if (!Array.isArray(data.interests) || data.interests.length > LIMITS.INTERESTS_MAX) {
            return 'Invalid field: interests';
        }
    }
    if (data.skills !== undefined) {
        if (!Array.isArray(data.skills) || data.skills.length > LIMITS.SKILLS_MAX) {
            return 'Invalid field: skills';
        }
    }
    return null;
}
