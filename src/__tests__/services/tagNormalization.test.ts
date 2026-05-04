/**
 * Tests for tag normalization and clustering logic
 * Run with: npm test -- tagNormalization.test.ts
 */

import { normalizeTagLabel, getNormalizedKey } from '@/services/tagNormalization';

describe('tagNormalization', () => {
    describe('normalizeTagLabel', () => {
        it('should lowercase labels', () => {
            expect(normalizeTagLabel('JavaScript')).toBe('javascript');
            expect(normalizeTagLabel('PYTHON')).toBe('python');
        });

        it('should remove accents', () => {
            expect(normalizeTagLabel('Café')).toBe('cafe');
            expect(normalizeTagLabel('Élève')).toBe('eleve');
            expect(normalizeTagLabel('naïve')).toBe('naive');
        });

        it('should handle spaces and hyphens', () => {
            expect(normalizeTagLabel('Java Script')).toBe('java script');
            expect(normalizeTagLabel('Java-Script')).toBe('java script');
            expect(normalizeTagLabel('java  script')).toBe('java script');
        });

        it('should remove punctuation', () => {
            expect(normalizeTagLabel('C++')).toBe('c');
            expect(normalizeTagLabel('C#')).toBe('c');
            expect(normalizeTagLabel('Node.js')).toBe('nodejs');
        });

        it('should treat common separators as word boundaries', () => {
            expect(normalizeTagLabel('Time_management')).toBe('time management');
            expect(normalizeTagLabel('time-management')).toBe('time management');
            expect(normalizeTagLabel('time/management')).toBe('time management');
            expect(normalizeTagLabel('Research & Design')).toBe('research design');
            expect(normalizeTagLabel('C++')).toBe('c');
        });

        it('should combine all transformations', () => {
            expect(normalizeTagLabel('Café-SHOP')).toBe('cafe shop');
            expect(normalizeTagLabel('JAva ScRipt 2.0')).toBe('java script 20');
            expect(normalizeTagLabel("Élève  d'école")).toBe('eleve decole');
        });

        it('should handle Unicode edge cases', () => {
            expect(normalizeTagLabel('Zürich')).toBe('zurich');
            expect(normalizeTagLabel('São Paulo')).toBe('sao paulo');
            expect(normalizeTagLabel('Москва')).toBe('москва'); // Cyrillic (doesn't have accents, should remain)
        });

        it('should trim whitespace', () => {
            expect(normalizeTagLabel('  JavaScript  ')).toBe('javascript');
            expect(normalizeTagLabel('\tPython\n')).toBe('python');
        });

        it('should cluster variant forms without spaces', () => {
            // These should all normalize to the same value (no spaces between parts)
            const variants = ['JavaScript', 'javascript', 'JAVASCRIPT'];
            const normalized = variants.map(normalizeTagLabel);
            expect(new Set(normalized).size).toBe(1); // All normalize to same value
            expect(normalized[0]).toBe('javascript');
        });

        it('should distinguish space-separated variants', () => {
            // Spaces and hyphens are preserved, so these are different clusters
            const noSpace = normalizeTagLabel('JavaScript');
            const withSpace = normalizeTagLabel('Java Script');
            const withHyphen = normalizeTagLabel('Java-Script');
            expect(noSpace).toBe('javascript');
            expect(withSpace).toBe('java script');
            expect(withHyphen).toBe('java script'); // Hyphens become spaces
            expect(new Set([noSpace, withSpace, withHyphen]).size).toBe(2); // Two unique clusters
        });
    });

    describe('getNormalizedKey', () => {
        it('should generate deterministic keys', () => {
            const key1 = getNormalizedKey('JavaScript', 'skill');
            const key2 = getNormalizedKey('JavaScript', 'skill');
            expect(key1).toBe(key2);
        });

        it('should differentiate by type', () => {
            const interestKey = getNormalizedKey('Photography', 'interest');
            const skillKey = getNormalizedKey('Photography', 'skill');
            expect(interestKey).not.toBe(skillKey);
            expect(interestKey).toContain('interest');
            expect(skillKey).toContain('skill');
        });

        it('should normalize labels in keys', () => {
            const key1 = getNormalizedKey('JAVA-Script', 'skill');
            const key2 = getNormalizedKey('java script', 'skill');
            expect(key1).toBe(key2);
        });

        it('should include type prefix', () => {
            const key = getNormalizedKey('Python', 'skill');
            expect(key).toMatch(/^skill::/);
        });
    });
});
