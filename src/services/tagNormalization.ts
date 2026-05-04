/**
 * Robust tag label normalization utilities.
 *
 * Normalization strategy:
 *   1. Unicode NFD: decompose accented chars (é → e + ´)
 *   2. Remove diacritics: strip combining marks
 *   3. Turn common word separators (_ / & +) into spaces
 *   4. Lowercase
 *   5. Remove non-word chars (keep letters/digits/spaces/hyphens)
 *   6. Compress spaces/hyphens to single space
 *   7. Trim
 *
 * Goals:
 *   - Group typos/variants: "JS", "javascript", "Java Script", "JaVa Script" → "js"
 *   - Prevent user duplicate-variants: only one tag per (userId, type, labelNorm)
 *   - Support multi-level clustering in promotion job
 *
 * Example outputs:
 *   "JS" → "js"
 *   "JavaScript" → "javascript"
 *   "Java Script" → "java script"
 *   "Café" → "cafe"
 *   "C++" → "c"
 *   "C-Sharp" → "c sharp"
 *   "Time_management" → "time management"
 *   "Research & Design" → "research design"
 *   "React.js" → "reactjs"
 */

export function normalizeTagLabel(label: string): string {
    if (!label) return '';

    return (
        label
            // 1. Normalize to NFD (decompose accents): é → e + combining accent
            .normalize('NFD')
            // 2. Remove diacritics (combining marks): \\p{Mn} in Unicode is "Mark, Nonspacing"
            .replace(/[\u0300-\u036f]/g, '')
            // 3. Lowercase
            .toLowerCase()
            // 4. Turn common typed separators into word boundaries before punctuation stripping.
            .replace(/[_/&+]+/g, ' ')
            // 5. Keep only letters (any script), digits, spaces, hyphens; remove other punctuation
            // Using a broader character set that includes Cyrillic, Greek, Arabic, etc.
            .replace(/[^\p{L}\p{N}\s-]/gu, '')
            // 6. Compress multiple spaces/hyphens to single space
            .replace(/[\s-]+/g, ' ')
            // 7. Trim
            .trim()
    );
}

/**
 * Generate a clustering key combining tag type and normalized label.
 * Used for deterministic grouping in promotion job.
 */
export function getNormalizedKey(label: string, type: 'interest' | 'skill'): string {
    return `${type}::${normalizeTagLabel(label)}`;
}

/**
 * Sanitize a tag label (existing function preserved for backwards compat).
 * Called FIRST before storing raw label on UserTag.
 *
 *   - Strip invisible/control characters
 *   - Collapse whitespace
 *   - Trim
 *   - Title-case first letter
 *   - Max length
 *
 * This preserves the "raw but clean" label for display.
 * Then normalizeTagLabel() derives the clustering key.
 */
export function sanitizeTagLabel(raw: string, maxLength: number = 40): string {
    const s = raw
        .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
    if (s.length === 0) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
}
