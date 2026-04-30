/**
 * Unit tests for the Mapbox Search Box proxy. We mock fetch and the
 * audit/metrics helpers, verify caching, retrieve fan-out, and that
 * recordApiUsage receives the expected provider/endpoint/status data.
 */

import os from 'os';
import path from 'path';

jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

const mockRecord = jest.fn();
jest.mock('@/services/apiMetricsService', () => ({
    recordApiUsage: (...args: unknown[]) => mockRecord(...args)
}));

const TEST_CACHE_DIR = path.join(os.tmpdir(), `whymeet-static-map-test-${process.pid}`);

jest.mock('@/config/env', () => ({
    env: {
        MAPBOX_ACCESS_TOKEN: 'tok-xyz',
        STATIC_MAP_CACHE_DIR: TEST_CACHE_DIR
    }
}));

jest.mock('@/services/featureFlagService', () => ({
    isFeatureEnabled: jest.fn().mockResolvedValue(true)
}));

import { searchPlaces, retrievePlace, fetchStaticMap } from '@/services/placesService';
import { __resetStaticMapCacheForTests } from '@/services/staticMapCache';

const realFetch = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

beforeEach(async () => {
    mockRecord.mockClear();
    await __resetStaticMapCacheForTests();
});

afterAll(async () => {
    global.fetch = realFetch;
    await __resetStaticMapCacheForTests();
});

test('searchPlaces returns lightweight suggestions (no /retrieve call)', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(
        jsonResponse({
            suggestions: [{ mapbox_id: 'mb1', name: 'Café Z', full_address: '1 rue X, Paris' }]
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await searchPlaces({ query: 'cafe', userId: 'u1' });
    expect(result).toEqual([{ id: 'mb1', name: 'Café Z', fullAddress: '1 rue X, Paris' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
        provider: 'mapbox',
        endpoint: 'searchbox/suggest',
        status: 200
    });
});

test('retrievePlace fetches coordinates for a single mapbox id', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(
        jsonResponse({
            features: [
                {
                    properties: {
                        mapbox_id: 'mb1',
                        name: 'Café Z',
                        full_address: '1 rue X, Paris',
                        coordinates: { latitude: 48.86, longitude: 2.33 }
                    }
                }
            ]
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const place = await retrievePlace({ id: 'mb1', userId: 'u-retrieve' });
    expect(place).toEqual({
        id: 'mb1',
        name: 'Café Z',
        fullAddress: '1 rue X, Paris',
        latitude: 48.86,
        longitude: 2.33
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
        provider: 'mapbox',
        endpoint: 'searchbox/retrieve',
        status: 200
    });
});

test('retrievePlace caches by id (2nd call hits cache)', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(
        jsonResponse({
            features: [
                {
                    properties: {
                        mapbox_id: 'mb-cache',
                        name: 'Cached',
                        full_address: 'somewhere',
                        coordinates: { latitude: 1, longitude: 2 }
                    }
                }
            ]
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const a = await retrievePlace({ id: 'mb-cache', userId: 'u-c' });
    const b = await retrievePlace({ id: 'mb-cache', userId: 'u-c' });
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('searchPlaces returns [] for too-short queries without calling fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await searchPlaces({ query: 'a', userId: 'u1' })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
});

test('searchPlaces records http error metrics on suggest failure', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonResponse({}, 429));
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await searchPlaces({ query: 'museum', userId: 'u2' });
    expect(result).toEqual([]);
    expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
            provider: 'mapbox',
            endpoint: 'searchbox/suggest',
            status: 429,
            errorCode: 'http_429'
        })
    );
});

function pngResponse(): Response {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/png' }
    });
}

const STATIC_ARGS = {
    latitude: 48.8566,
    longitude: 2.3522,
    zoom: 14,
    width: 600,
    height: 300,
    retina: false
};

test('fetchStaticMap caches successful responses (2nd call hits cache)', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(pngResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = await fetchStaticMap(STATIC_ARGS);
    const second = await fetchStaticMap(STATIC_ARGS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(second.contentType).toBe('image/png');
    // Only the miss should record a Mapbox call.
    const staticCalls = mockRecord.mock.calls.filter(
        (c) => (c[0] as { endpoint: string }).endpoint === 'static/streets-v12'
    );
    expect(staticCalls).toHaveLength(1);
});

test('fetchStaticMap differentiates cache entries by args', async () => {
    const fetchMock = jest.fn().mockImplementation(() => Promise.resolve(pngResponse()));
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchStaticMap(STATIC_ARGS);
    await fetchStaticMap({ ...STATIC_ARGS, zoom: 16 });
    await fetchStaticMap({ ...STATIC_ARGS, retina: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('fetchStaticMap does not cache HTTP errors', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(jsonResponse({}, 500)).mockResolvedValueOnce(pngResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchStaticMap(STATIC_ARGS)).rejects.toThrow();
    const ok = await fetchStaticMap(STATIC_ARGS);
    expect(ok.contentType).toBe('image/png');
    expect(fetchMock).toHaveBeenCalledTimes(2);
});
