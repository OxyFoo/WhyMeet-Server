/**
 * Unit tests for the Mapbox Search Box proxy. We mock fetch and the
 * audit/metrics helpers, verify caching, retrieve fan-out, and that
 * recordApiUsage receives the expected provider/endpoint/status data.
 */

jest.mock('@/config/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), success: jest.fn() }
}));

const mockRecord = jest.fn();
jest.mock('@/services/apiMetricsService', () => ({
    recordApiUsage: (...args: unknown[]) => mockRecord(...args)
}));

jest.mock('@/config/env', () => ({
    env: { MAPBOX_ACCESS_TOKEN: 'tok-xyz' }
}));

import { searchPlaces } from '@/services/placesService';

const realFetch = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

beforeEach(() => {
    mockRecord.mockClear();
});

afterAll(() => {
    global.fetch = realFetch;
});

test('searchPlaces returns suggestions resolved through retrieve', async () => {
    const fetchMock = jest
        .fn()
        // suggest
        .mockResolvedValueOnce(
            jsonResponse({
                suggestions: [{ mapbox_id: 'mb1', name: 'Café Z', full_address: '1 rue X, Paris' }]
            })
        )
        // retrieve
        .mockResolvedValueOnce(
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

    const result = await searchPlaces({ query: 'cafe', userId: 'u1' });
    expect(result).toEqual([
        { id: 'mb1', name: 'Café Z', fullAddress: '1 rue X, Paris', latitude: 48.86, longitude: 2.33 }
    ]);
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
        provider: 'mapbox',
        endpoint: 'searchbox/suggest',
        status: 200
    });
    expect(mockRecord.mock.calls[1][0]).toMatchObject({
        provider: 'mapbox',
        endpoint: 'searchbox/retrieve',
        status: 200
    });
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
