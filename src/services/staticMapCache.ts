import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

/**
 * Disk-based cache for Mapbox Static Map images.
 *
 * Why disk and not RAM/Redis:
 * - Static map images for an activity are immutable (coords don't change
 *   once an activity is created and Mapbox tiles are stable).
 * - Stored forever: no TTL, no eviction. Mount as a Docker volume in prod.
 * - Each entry ~50–400 KB; modern disks have plenty of room.
 * - Bumping `KEY_VERSION` lets us invalidate the whole cache if Mapbox
 *   rendering changes meaningfully.
 *
 * The Mapbox static endpoint we use always returns PNG, so we don't need
 * to persist the content-type alongside the buffer.
 */

const KEY_VERSION = 'v1';
const CONTENT_TYPE = 'image/png';

let initPromise: Promise<void> | null = null;

export interface StaticMapPayload {
    buffer: Buffer;
    contentType: string;
}

export interface StaticMapCacheArgs {
    latitude: number;
    longitude: number;
    zoom: number;
    width: number;
    height: number;
    retina: boolean;
}

function canonicalKey(args: StaticMapCacheArgs): string {
    const lat = args.latitude.toFixed(5);
    const lng = args.longitude.toFixed(5);
    const z = args.zoom.toFixed(2);
    const w = Math.round(args.width);
    const h = Math.round(args.height);
    const r = args.retina ? '1' : '0';
    return `${KEY_VERSION}:${lat}:${lng}:${z}:${w}:${h}:${r}`;
}

function hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
}

function entryPath(hash: string): string {
    // Shard into 256 sub-directories to avoid huge flat folders.
    return path.join(env.STATIC_MAP_CACHE_DIR, hash.slice(0, 2), `${hash.slice(2)}.png`);
}

async function ensureCacheDir(): Promise<void> {
    if (!initPromise) {
        initPromise = fs.mkdir(env.STATIC_MAP_CACHE_DIR, { recursive: true }).then(() => undefined);
    }
    return initPromise;
}

export async function getCachedStaticMap(args: StaticMapCacheArgs): Promise<StaticMapPayload | null> {
    const file = entryPath(hashKey(canonicalKey(args)));
    try {
        const buffer = await fs.readFile(file);
        return { buffer, contentType: CONTENT_TYPE };
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        logger.warn('[StaticMapCache] Disk error on get', err);
        return null;
    }
}

export async function putCachedStaticMap(args: StaticMapCacheArgs, payload: StaticMapPayload): Promise<void> {
    const file = entryPath(hashKey(canonicalKey(args)));
    try {
        await ensureCacheDir();
        await fs.mkdir(path.dirname(file), { recursive: true });
        // Write to a temp file then rename so a crash mid-write doesn't leave
        // a partial file readable on the next request.
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, payload.buffer);
        await fs.rename(tmp, file);
    } catch (err) {
        logger.warn('[StaticMapCache] Disk error on put', err);
    }
}

/** Test-only: clear the disk cache directory. */
export async function __resetStaticMapCacheForTests(): Promise<void> {
    initPromise = null;
    try {
        await fs.rm(env.STATIC_MAP_CACHE_DIR, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}
