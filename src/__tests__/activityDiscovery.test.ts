jest.mock('@/services/database', () => ({ getDatabase: jest.fn() }));

import { passesAgeFilter } from '@/services/activityDiscoveryService';

/** Build a Date such that computeAge() returns exactly `age` today. */
function birthDateForAge(age: number): Date {
    const d = new Date();
    d.setFullYear(d.getFullYear() - age);
    return d;
}

describe('passesAgeFilter', () => {
    it('includes activity when viewer has no birthDate', () => {
        expect(passesAgeFilter(null, [30, 50])).toBe(true);
    });

    it('includes activity when targetAgeRange is empty/malformed', () => {
        expect(passesAgeFilter(birthDateForAge(35), [])).toBe(true);
    });

    it('excludes viewer aged 25 from range [30, 50]', () => {
        expect(passesAgeFilter(birthDateForAge(25), [30, 50])).toBe(false);
    });

    it('includes viewer aged 35 in range [30, 50]', () => {
        expect(passesAgeFilter(birthDateForAge(35), [30, 50])).toBe(true);
    });

    it('excludes viewer aged 55 from range [30, 50]', () => {
        expect(passesAgeFilter(birthDateForAge(55), [30, 50])).toBe(false);
    });

    it('includes viewer aged 85 in range [30, 80] (80+ means no upper bound)', () => {
        expect(passesAgeFilter(birthDateForAge(85), [30, 80])).toBe(true);
    });

    it('includes viewer aged 80 in range [30, 80]', () => {
        expect(passesAgeFilter(birthDateForAge(80), [30, 80])).toBe(true);
    });

    it('excludes viewer aged 25 from range [30, 80]', () => {
        expect(passesAgeFilter(birthDateForAge(25), [30, 80])).toBe(false);
    });
});
