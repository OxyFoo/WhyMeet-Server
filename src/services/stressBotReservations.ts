const BOT_PREP_RESERVATION_TTL_MS = 120_000;
const reservedStressBotUserIds = new Map<string, number>();

function pruneStressBotReservations(now = Date.now()): void {
    for (const [userId, expiresAt] of reservedStressBotUserIds.entries()) {
        if (expiresAt <= now) reservedStressBotUserIds.delete(userId);
    }
}

export function reserveStressBots(userIds: readonly string[], now = Date.now()): void {
    pruneStressBotReservations(now);
    const expiresAt = now + BOT_PREP_RESERVATION_TTL_MS;
    for (const userId of userIds) reservedStressBotUserIds.set(userId, expiresAt);
}

export function getReservedStressBotUserIds(now = Date.now()): string[] {
    pruneStressBotReservations(now);
    return [...reservedStressBotUserIds.keys()];
}

export function releaseStressBotReservations(userIds: readonly string[]): number {
    let released = 0;
    for (const userId of userIds) {
        if (reservedStressBotUserIds.delete(userId)) released++;
    }
    return released;
}

export function clearStressBotReservations(): void {
    reservedStressBotUserIds.clear();
}
