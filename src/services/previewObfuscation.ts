/**
 * Preview helpers used by `preview-search` (people) and
 * `preview-search-activities` to scramble strings while keeping the
 * overall visual shape (length, spaces, punctuation, emojis).
 */

import type { MatchCandidate } from '@oxyfoo/whymeet-types';

const LOWERS = 'abcdefghijklmnopqrstuvwxyz';
const UPPERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

/**
 * Replace each letter with a random letter of the same case and each
 * digit with a random digit. Non-alphanumeric characters (spaces,
 * punctuation, emojis) are preserved verbatim.
 */
export function obfuscateString(str: string): string {
    let result = '';
    for (const ch of str) {
        if (LOWERS.includes(ch)) {
            result += LOWERS[Math.floor(Math.random() * 26)];
        } else if (UPPERS.includes(ch)) {
            result += UPPERS[Math.floor(Math.random() * 26)];
        } else if (DIGITS.includes(ch)) {
            result += DIGITS[Math.floor(Math.random() * 10)];
        } else {
            result += ch;
        }
    }
    return result;
}

function obfuscateAge(age: number): number {
    const base = Number.isFinite(age) && age >= 18 ? age : 25;
    const delta = Math.floor(Math.random() * 7) - 3;
    return Math.max(18, Math.min(99, base + delta));
}

export function obfuscateCandidatePreview(candidate: MatchCandidate): MatchCandidate {
    return {
        ...candidate,
        user: {
            ...candidate.user,
            name: obfuscateString(candidate.user.name),
            age: obfuscateAge(candidate.user.age),
            city: candidate.user.city ? obfuscateString(candidate.user.city) : candidate.user.city,
            isPremium: false,
            isBoosted: false
        },
        bio: obfuscateString(candidate.bio),
        interests: candidate.interests.map(obfuscateString),
        skills: candidate.skills.map(obfuscateString),
        distance: candidate.distance ? obfuscateString(candidate.distance) : candidate.distance,
        blurred: true
    };
}
