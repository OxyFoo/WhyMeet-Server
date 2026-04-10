const EARTH_KM_PER_DEG = 111.32;

/**
 * Discretize a GPS position onto a ~1 km × 1 km grid.
 * Replaces the exact coordinate with the nearest grid intersection point.
 *
 * - Latitude step: 1 / 111.32 ≈ 0.008983° (≈ 1 km everywhere)
 * - Longitude step: 1 / (111.32 × cos(lat)) (≈ 1 km adjusted for latitude)
 */
export function discretizePosition(lat: number, lng: number): { latitude: number; longitude: number } {
    // Snap latitude
    const STEP_LAT = 1 / EARTH_KM_PER_DEG;
    const latitude = parseFloat((Math.round(lat / STEP_LAT) * STEP_LAT).toFixed(6));

    // Compute longitude step from the discretized latitude (ensures idempotency)
    const latRad = (latitude * Math.PI) / 180;
    const cosLat = Math.cos(latRad);
    const safeCosLat = Math.abs(cosLat) > 1e-6 ? Math.abs(cosLat) : 1;

    // Snap longitude
    const STEP_LNG = 1 / (EARTH_KM_PER_DEG * safeCosLat);
    const longitude = parseFloat((Math.round(lng / STEP_LNG) * STEP_LNG).toFixed(6));

    return { latitude, longitude };
}
