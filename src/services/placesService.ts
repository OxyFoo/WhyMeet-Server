import type { PlaceSuggestion, PlaceSuggestionLite } from '@oxyfoo/whymeet-types';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { recordApiUsage } from '@/services/apiMetricsService';
import { isFeatureEnabled } from '@/services/featureFlagService';
import { getCachedStaticMap, putCachedStaticMap } from '@/services/staticMapCache';

export class MapboxDisabledError extends Error {
    constructor() {
        super('mapbox_disabled');
        this.name = 'MapboxDisabledError';
    }
}

const MAPBOX_BASE = 'https://api.mapbox.com/search/searchbox/v1';
const PROVIDER = 'mapbox';
const ENDPOINT_SUGGEST = 'searchbox/suggest';
const ENDPOINT_RETRIEVE = 'searchbox/retrieve';
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 h, Mapbox session window
const SUGGEST_CACHE_TTL_MS = 60 * 60 * 1000;
const SUGGEST_CACHE_MAX = 500;
const RETRIEVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RETRIEVE_CACHE_MAX = 2000;

type SuggestEntry = { value: PlaceSuggestionLite[]; expiresAt: number };
const suggestCache = new Map<string, SuggestEntry>();

type RetrieveEntry = { value: PlaceSuggestion; expiresAt: number };
const retrieveCache = new Map<string, RetrieveEntry>();

// Mapbox Search Box billing model: a session = one or more /suggest calls
// followed by a single /retrieve. We keep one session per user so that
// successive keystrokes for the same search are billed once.
const userSessions = new Map<string, { id: string; expiresAt: number }>();

function getSessionToken(userId: string): string {
    const now = Date.now();
    const existing = userSessions.get(userId);
    if (existing && existing.expiresAt > now) return existing.id;
    const id = `${userId}-${now}-${Math.random().toString(36).slice(2, 10)}`;
    userSessions.set(userId, { id, expiresAt: now + SESSION_TTL_MS });
    return id;
}

/**
 * Reset the session token for a user. Called after a successful /retrieve so
 * the next search opens a fresh billing session, matching Mapbox's spec
 * ("calling /suggest followed by /retrieve with a common session_token" ends
 * the session).
 */
function endSession(userId: string): void {
    userSessions.delete(userId);
}

function suggestCacheKey(query: string, language: string, lat?: number, lng?: number): string {
    const latR = lat != null ? lat.toFixed(2) : '-';
    const lngR = lng != null ? lng.toFixed(2) : '-';
    return `${language}|${latR}|${lngR}|${query.toLowerCase().trim()}`;
}

function lruPut<V>(
    map: Map<string, { value: V; expiresAt: number }>,
    max: number,
    key: string,
    value: V,
    ttl: number
): void {
    if (map.size >= max) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, { value, expiresAt: Date.now() + ttl });
}

function lruGet<V>(map: Map<string, { value: V; expiresAt: number }>, key: string): V | null {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
        map.delete(key);
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
 * Fetch up to 5 lightweight place suggestions for a free-text query. Does
 * NOT resolve coordinates — the client must call {@link retrievePlace} once
 * the user picks a result. This split is required to avoid being billed for
 * one Mapbox session per displayed suggestion.
 */
export async function searchPlaces(args: {
    query: string;
    language?: string;
    latitude?: number;
    longitude?: number;
    userId: string;
}): Promise<PlaceSuggestionLite[]> {
    if (!(await isFeatureEnabled('mapbox'))) {
        throw new MapboxDisabledError();
    }
    const token = env.MAPBOX_ACCESS_TOKEN;
    if (!token) {
        logger.warn('[Places] MAPBOX_ACCESS_TOKEN is not configured');
        return [];
    }

    const query = args.query.trim();
    if (query.length < 2) return [];

    const language = (args.language ?? 'fr').slice(0, 5);
    const key = suggestCacheKey(query, language, args.latitude, args.longitude);
    const cached = lruGet(suggestCache, key);
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

    const suggestions: PlaceSuggestionLite[] = raw.map((s) => ({
        id: s.mapbox_id,
        name: s.name,
        fullAddress: s.full_address ?? s.place_formatted ?? s.name
    }));
    lruPut(suggestCache, SUGGEST_CACHE_MAX, key, suggestions, SUGGEST_CACHE_TTL_MS);
    return suggestions;
}

/**
 * Resolve coordinates for a single suggestion. Must be called with the same
 * `userId` that produced the suggestion so that Mapbox bills one session for
 * the whole `/suggest` → `/retrieve` cycle.
 */
export async function retrievePlace(args: {
    id: string;
    language?: string;
    userId: string;
}): Promise<PlaceSuggestion | null> {
    if (!(await isFeatureEnabled('mapbox'))) {
        throw new MapboxDisabledError();
    }
    const token = env.MAPBOX_ACCESS_TOKEN;
    if (!token) {
        logger.warn('[Places] MAPBOX_ACCESS_TOKEN is not configured');
        return null;
    }

    const language = (args.language ?? 'fr').slice(0, 5);
    const cacheKey = `${language}|${args.id}`;
    const cached = lruGet(retrieveCache, cacheKey);
    if (cached) return cached;

    const session = getSessionToken(args.userId);

    const url = new URL(`${MAPBOX_BASE}/retrieve/${encodeURIComponent(args.id)}`);
    url.searchParams.set('session_token', session);
    url.searchParams.set('language', language);
    url.searchParams.set('access_token', token);

    const res = await callMapbox<{ features: MapboxFeature[] }>(ENDPOINT_RETRIEVE, url.toString(), args.userId);
    // /retrieve closes the Mapbox billing session — drop the token so the next
    // search starts a new one.
    endSession(args.userId);
    if (!res.ok) return null;
    const f = res.data.features?.[0];
    if (!f) return null;
    const lng = f.properties.coordinates?.longitude ?? f.geometry?.coordinates?.[0];
    const lat = f.properties.coordinates?.latitude ?? f.geometry?.coordinates?.[1];
    if (lat == null || lng == null) return null;
    const place: PlaceSuggestion = {
        id: args.id,
        name: f.properties.name,
        fullAddress: f.properties.full_address ?? f.properties.place_formatted ?? f.properties.name,
        latitude: lat,
        longitude: lng
    };
    lruPut(retrieveCache, RETRIEVE_CACHE_MAX, cacheKey, place, RETRIEVE_CACHE_TTL_MS);
    return place;
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
    if (!(await isFeatureEnabled('mapbox'))) {
        throw new MapboxDisabledError();
    }
    const token = env.MAPBOX_ACCESS_TOKEN;
    if (!token) throw new Error('mapbox_token_missing');

    const cached = await getCachedStaticMap(args);
    if (cached) return cached;

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
        const payload = {
            buffer: Buffer.from(arrayBuf),
            contentType: res.headers.get('content-type') ?? 'image/png'
        };
        await putCachedStaticMap(args, payload);
        return payload;
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
