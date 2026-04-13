const EARTH_KM_PER_DEG = 111.32;
const GRID_SIZE_KM = 2;

/**
 * Discretize a GPS position onto a ~2 km × 2 km grid.
 * Replaces the exact coordinate with the nearest grid intersection point.
 *
 * - Latitude step: GRID_SIZE_KM / 111.32 ≈ 0.017966° (≈ GRID_SIZE_KM km everywhere)
 * - Longitude step: GRID_SIZE_KM / (111.32 × cos(lat)) (≈ GRID_SIZE_KM km adjusted for latitude)
 */
export function discretizePosition(lat: number, lng: number): { latitude: number; longitude: number } {
    // Snap latitude
    const STEP_LAT = GRID_SIZE_KM / EARTH_KM_PER_DEG;
    const latitude = parseFloat((Math.round(lat / STEP_LAT) * STEP_LAT).toFixed(6));

    // Compute longitude step from the discretized latitude (ensures idempotency)
    const latRad = (latitude * Math.PI) / 180;
    const cosLat = Math.cos(latRad);
    const safeCosLat = Math.abs(cosLat) > 1e-6 ? Math.abs(cosLat) : 1;

    // Snap longitude
    const STEP_LNG = GRID_SIZE_KM / (EARTH_KM_PER_DEG * safeCosLat);
    const longitude = parseFloat((Math.round(lng / STEP_LNG) * STEP_LNG).toFixed(6));

    return { latitude, longitude };
}
