import type { PlaceSuggestion } from '@oxyfoo/whymeet-types';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { recordApiUsage } from '@/services/apiMetricsService';

const MAPBOX_BASE = 'https://api.mapbox.com/search/searchbox/v1';
const PROVIDER = 'mapbox';
const ENDPOINT_SUGGEST = 'searchbox/suggest';
const ENDPOINT_RETRIEVE = 'searchbox/retrieve';
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 h, Mapbox session window
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;

type SuggestionEntry = { value: PlaceSuggestion[]; expiresAt: number };
const cache = new Map<string, SuggestionEntry>();

// Mapbox Search Box billing model: a session = one suggest+retrieve cycle.
// We keep one session per user so a single search isn't double-billed.
const userSessions = new Map<string, { id: string; expiresAt: number }>();

function getSessionToken(userId: string): string {
    const now = Date.now();
    const existing = userSessions.get(userId);
    if (existing && existing.expiresAt > now) return existing.id;
    const id = `${userId}-${now}-${Math.random().toString(36).slice(2, 10)}`;
    userSessions.set(userId, { id, expiresAt: now + SESSION_TTL_MS });
    return id;
}

function cacheKey(query: string, language: string, lat?: number, lng?: number): string {
    const latR = lat != null ? lat.toFixed(2) : '-';
    const lngR = lng != null ? lng.toFixed(2) : '-';
    return `${language}|${latR}|${lngR}|${query.toLowerCase().trim()}`;
}

function cachePut(key: string, value: PlaceSuggestion[]): void {
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheGet(key: string): PlaceSuggestion[] | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
        cache.delete(key);
        return null;
    }
    return entry.value;
}

type MapboxSuggestion = {
    mapbox_id: string;
    name: string;
    place_formatted?: string;
    full_address?: string;
};
type MapboxFeature = {
    properties: {
        mapbox_id: string;
        name: string;
        place_formatted?: string;
        full_address?: string;
        coordinates?: { latitude: number; longitude: number };
    };
    geometry?: { coordinates: [number, number] };
};

async function callMapbox<T>(
    endpoint: string,
    url: string,
    userId: string | null
): Promise<{ ok: true; data: T } | { ok: false }> {
    const start = Date.now();
    try {
        const res = await fetch(url);
        const latency = Date.now() - start;
        if (!res.ok) {
            recordApiUsage({
                provider: PROVIDER,
                endpoint,
                status: res.status,
                latencyMs: latency,
                userId,
                errorCode: `http_${res.status}`
            });
            logger.warn(`[Places] Mapbox ${endpoint} returned ${res.status}`);
            return { ok: false };
        }
        const data = (await res.json()) as T;
        recordApiUsage({
            provider: PROVIDER,
            endpoint,
            status: res.status,
            latencyMs: latency,
            userId
        });
        return { ok: true, data };
    } catch (err) {
        const latency = Date.now() - start;
        recordApiUsage({
            provider: PROVIDER,
            endpoint,
            status: 0,
            latencyMs: latency,
            userId,
            errorCode: 'network_error'
        });
        logger.warn(`[Places] Mapbox ${endpoint} fetch error`, err);
        return { ok: false };
    }
}

/**
 * Fetch up to 5 place suggestions for a free-text query. Results contain
 * latitude/longitude resolved via Mapbox's retrieve endpoint so the client can
 * persist a precise position.
 */
export async function searchPlaces(args: {
    query: string;
    language?: string;
    latitude?: number;
    longitude?: number;
    userId: string;
}): Promise<PlaceSuggestion[]> {
    const token = env.MAPBOX_ACCESS_TOKEN;
    if (!token) {
        logger.warn('[Places] MAPBOX_ACCESS_TOKEN is not configured');
        return [];
    }

    const query = args.query.trim();
    if (query.length < 2) return [];

    const language = (args.language ?? 'fr').slice(0, 5);
    const key = cacheKey(query, language, args.latitude, args.longitude);
    const cached = cacheGet(key);
    if (cached) return cached;

    const session = getSessionToken(args.userId);

    const suggestUrl = new URL(`${MAPBOX_BASE}/suggest`);
    suggestUrl.searchParams.set('q', query);
    suggestUrl.searchParams.set('language', language);
    suggestUrl.searchParams.set('limit', '5');
    suggestUrl.searchParams.set('session_token', session);
    suggestUrl.searchParams.set('access_token', token);
    if (args.latitude != null && args.longitude != null) {
        suggestUrl.searchParams.set('proximity', `${args.longitude},${args.latitude}`);
    }

    const suggestRes = await callMapbox<{ suggestions: MapboxSuggestion[] }>(
        ENDPOINT_SUGGEST,
        suggestUrl.toString(),
        args.userId
    );
    if (!suggestRes.ok) return [];
    const raw = suggestRes.data.suggestions ?? [];

    // Resolve coordinates for each suggestion via /retrieve. Done in parallel.
    const retrieved = await Promise.all(
        raw.map(async (s) => {
            const url = new URL(`${MAPBOX_BASE}/retrieve/${encodeURIComponent(s.mapbox_id)}`);
            url.searchParams.set('session_token', session);
            url.searchParams.set('access_token', token);
            const res = await callMapbox<{ features: MapboxFeature[] }>(ENDPOINT_RETRIEVE, url.toString(), args.userId);
            if (!res.ok) return null;
            const f = res.data.features?.[0];
            if (!f) return null;
            const lng = f.properties.coordinates?.longitude ?? f.geometry?.coordinates?.[0];
            const lat = f.properties.coordinates?.latitude ?? f.geometry?.coordinates?.[1];
            if (lat == null || lng == null) return null;
            return {
                id: s.mapbox_id,
                name: s.name,
                fullAddress: s.full_address ?? s.place_formatted ?? s.name,
                latitude: lat,
                longitude: lng
            } satisfies PlaceSuggestion;
        })
    );

    const suggestions = retrieved.filter((x): x is PlaceSuggestion => x !== null);
    cachePut(key, suggestions);
    return suggestions;
}

const STATIC_BASE = 'https://api.mapbox.com/styles/v1/mapbox/streets-v12/static';
const ENDPOINT_STATIC = 'static/streets-v12';

/**
 * Proxy a Mapbox Static Image (with a pin marker centered on `latitude`/`longitude`).
 * The Mapbox token never leaves the server.
 */
export async function fetchStaticMap(args: {
    latitude: number;
    longitude: number;
    zoom: number;
    width: number;
    height: number;
    retina: boolean;
}): Promise<{ buffer: Buffer; contentType: string }> {
    const token = env.MAPBOX_ACCESS_TOKEN;
    if (!token) throw new Error('mapbox_token_missing');

    const lng = args.longitude.toFixed(5);
    const lat = args.latitude.toFixed(5);
    const w = Math.round(args.width);
    const h = Math.round(args.height);
    const z = args.zoom.toFixed(2);
    const retina = args.retina ? '@2x' : '';
    const marker = `pin-s+ff4757(${lng},${lat})`;
    const url = `${STATIC_BASE}/${marker}/${lng},${lat},${z},0/${w}x${h}${retina}?access_token=${encodeURIComponent(token)}`;

    const start = Date.now();
    try {
        const res = await fetch(url);
        const latency = Date.now() - start;
        if (!res.ok) {
            recordApiUsage({
                provider: PROVIDER,
                endpoint: ENDPOINT_STATIC,
                status: res.status,
                latencyMs: latency,
                userId: null,
                errorCode: `http_${res.status}`
            });
            throw new Error(`mapbox_static_http_${res.status}`);
        }
        const arrayBuf = await res.arrayBuffer();
        recordApiUsage({
            provider: PROVIDER,
            endpoint: ENDPOINT_STATIC,
            status: res.status,
            latencyMs: latency,
            userId: null
        });
        return {
            buffer: Buffer.from(arrayBuf),
            contentType: res.headers.get('content-type') ?? 'image/png'
        };
    } catch (err) {
        const latency = Date.now() - start;
        recordApiUsage({
            provider: PROVIDER,
            endpoint: ENDPOINT_STATIC,
            status: 0,
            latencyMs: latency,
            userId: null,
            errorCode: 'network_error'
        });
        logger.warn('[Places] Mapbox static-map fetch error', err);
        throw err;
    }
}
