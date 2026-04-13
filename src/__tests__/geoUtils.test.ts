import { discretizePosition } from '@/services/geoUtils';

describe('discretizePosition', () => {
    it('should snap two nearby points (<1km) to the same grid cell', () => {
        // Paris center: 48.8566, 2.3522
        const a = discretizePosition(48.8566, 2.3522);
        const b = discretizePosition(48.857, 2.3525); // ~50m away
        expect(a.latitude).toBe(b.latitude);
        expect(a.longitude).toBe(b.longitude);
    });

    it('should produce different cells for points >3 km apart', () => {
        const a = discretizePosition(48.8566, 2.3522); // Paris center
        const b = discretizePosition(48.884, 2.3522); // ~3 km north
        expect(a.latitude).not.toBe(b.latitude);
    });

    it('should return values that are multiples of the grid step', () => {
        const STEP_LAT = 2 / 111.32;
        const result = discretizePosition(48.8566, 2.3522);

        const latIndex = result.latitude / STEP_LAT;
        expect(Math.abs(latIndex - Math.round(latIndex))).toBeLessThan(0.001);
    });

    it('should work at the equator (lat=0)', () => {
        const result = discretizePosition(0.004, 36.8);
        expect(result.latitude).toBeDefined();
        expect(result.longitude).toBeDefined();
        // At equator, STEP_LAT ≈ STEP_LNG
        const STEP = 2 / 111.32;
        const latIndex = result.latitude / STEP;
        expect(Math.abs(latIndex - Math.round(latIndex))).toBeLessThan(0.001);
    });

    it('should work at high latitudes (±60°)', () => {
        const north = discretizePosition(60.1699, 24.9384); // Helsinki
        expect(north.latitude).toBeDefined();
        expect(north.longitude).toBeDefined();

        const south = discretizePosition(-60.0, 24.0);
        expect(south.latitude).toBeDefined();
        expect(south.longitude).toBeDefined();
    });

    it('should handle longitude near ±180°', () => {
        const a = discretizePosition(0, 179.999);
        expect(a.longitude).toBeDefined();

        const b = discretizePosition(0, -179.999);
        expect(b.longitude).toBeDefined();
    });

    it('should be idempotent', () => {
        const first = discretizePosition(48.8566, 2.3522);
        const second = discretizePosition(first.latitude, first.longitude);
        expect(second.latitude).toBe(first.latitude);
        expect(second.longitude).toBe(first.longitude);
    });
});
