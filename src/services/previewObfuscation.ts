/**
 * Preview helpers used by `preview-search` (people) and
 * `preview-search-activities` to scramble strings while keeping the
 * overall visual shape (length, spaces, punctuation, emojis).
 */

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
