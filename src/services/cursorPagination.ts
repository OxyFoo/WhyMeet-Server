/**
 * @file cursorPagination.ts
 * @description Helpers to encode/decode opaque cursors and to slice query
 * results into a `CursorPageResponse` shape. All WS commands that paginate
 * over a list MUST use these helpers so the contract stays uniform across
 * domains.
 *
 * Cursor format: base64url-encoded JSON `{ k: string; i: string }` where
 *   - `k` is the value of the primary sort field (ISO date, numeric id...)
 *     formatted as a string. `null`/`undefined` sort values are encoded as
 *     the empty string and treated as the "end" of an ASC NULLS LAST sort.
 *   - `i` is a stable tie-breaker (the row id) so two rows sharing the same
 *     `k` are still strictly ordered.
 *
 * The opaque format means we can change the internal shape later without
 * breaking clients (they pass the cursor back as-is).
 */

import type { CursorPageResponse } from '@oxyfoo/whymeet-types';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '@oxyfoo/whymeet-types';
import { logger } from '@/config/logger';

interface DecodedCursor {
    k: string;
    i: string;
}

/**
 * Encode a sort key + tie-breaker id into an opaque base64url cursor.
 * Pass `null`/`undefined` for `sortKey` to mark a "no value" boundary
 * (useful when the primary sort is `NULLS LAST`).
 */
export function encodeCursor(sortKey: string | number | Date | null | undefined, id: string): string {
    const k =
        sortKey instanceof Date
            ? sortKey.toISOString()
            : sortKey === null || sortKey === undefined
              ? ''
              : String(sortKey);
    const json = JSON.stringify({ k, i: id });
    return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode a previously-issued cursor. Returns `null` if the cursor is
 * missing or malformed; callers should treat that as "start from the
 * beginning" rather than erroring out.
 */
export function decodeCursor(cursor: string | undefined): DecodedCursor | null {
    if (!cursor) return null;
    try {
        const raw = Buffer.from(cursor, 'base64url').toString('utf8');
        const parsed = JSON.parse(raw) as Partial<DecodedCursor>;
        if (typeof parsed.k !== 'string' || typeof parsed.i !== 'string') return null;
        return { k: parsed.k, i: parsed.i };
    } catch (err) {
        logger.warn('[Pagination] Failed to decode cursor', { cursor, err });
        return null;
    }
}

/**
 * Clamp an incoming `limit` from the client to the server-enforced
 * maximum. Falls back to the shared default when unset.
 */
export function resolveLimit(requested: number | undefined): number {
    if (!requested || requested <= 0) return DEFAULT_PAGE_SIZE;
    return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

/**
 * Slice a `limit + 1` fetch into a `CursorPageResponse`. The query is
 * expected to be ordered the same way the cursor was issued; the helper
 * does not re-sort.
 *
 * @param rows  Query result, at most `limit + 1` items.
 * @param limit Page size the caller asked for (already clamped).
 * @param getSortKey  Extracts the value of the primary sort field on a row.
 * @param getId Extracts the row id used as the tie-breaker.
 * @param map   Maps a row to the output item type sent to the client.
 */
export function paginateCursor<TRow, TOut>(
    rows: TRow[],
    limit: number,
    getSortKey: (row: TRow) => string | number | Date | null | undefined,
    getId: (row: TRow) => string,
    map: (row: TRow) => TOut
): CursorPageResponse<TOut> {
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(getSortKey(last), getId(last)) : null;
    return { items: sliced.map(map), nextCursor };
}
