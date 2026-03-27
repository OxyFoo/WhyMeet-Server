import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env';
import { getDatabase } from '@/services/database';

// ─── Hashing ─────────────────────────────────────────────────────────

function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Session Token ───────────────────────────────────────────────────

function generateSessionToken(): string {
    return crypto.randomUUID();
}

function checkSessionToken(storedHash: string, token: string): boolean {
    return crypto.timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(storedHash, 'hex'));
}

async function cycleSessionToken(deviceId: string): Promise<string> {
    const db = getDatabase();
    const newToken = generateSessionToken();
    await db.device.update({
        where: { id: deviceId },
        data: { sessionTokenHash: hashToken(newToken), lastSeenAt: new Date() }
    });
    return newToken;
}

// ─── Mail Token (AES-128-GCM encrypted) ─────────────────────────────

function ensureKeyLength(key: string, length: number): Buffer {
    const buf = Buffer.alloc(length);
    Buffer.from(key, 'utf8').copy(buf);
    return buf;
}

function generateMailToken(userId: string, deviceId: string): string | null {
    try {
        const plaintext = `${userId}\t${deviceId}\t${Date.now()}\t${crypto.randomBytes(16).toString('hex')}`;
        const iv = crypto.randomBytes(12);
        const keyBuffer = ensureKeyLength(env.CRYPT_KEY_MAIL, 16);
        const cipher = crypto.createCipheriv('aes-128-gcm', keyBuffer, iv);
        const encrypted = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
        const authTag = cipher.getAuthTag();
        return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    } catch {
        return null;
    }
}

function parseMailToken(token: string): { userId: string; deviceId: string; time: number } | null {
    try {
        const [ivHex, authTagHex, encryptedText] = token.split(':');
        if (!ivHex || !authTagHex || !encryptedText) return null;

        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const keyBuffer = ensureKeyLength(env.CRYPT_KEY_MAIL, 16);
        const decipher = crypto.createDecipheriv('aes-128-gcm', keyBuffer, iv);
        decipher.setAuthTag(authTag);
        const decrypted = decipher.update(encryptedText, 'hex', 'utf8') + decipher.final('utf8');

        const parts = decrypted.split('\t');
        if (parts.length < 3) return null;

        return {
            userId: parts[0],
            deviceId: parts[1],
            time: parseInt(parts[2], 10)
        };
    } catch {
        return null;
    }
}

async function confirmMailToken(token: string): Promise<{ userId: string; deviceId: string } | null> {
    const parsed = parseMailToken(token);
    if (!parsed) return null;

    // Check token expiration
    const ttlMs = env.MAIL_TOKEN_TTL_MINUTES * 60 * 1000;
    if (Date.now() - parsed.time > ttlMs) return null;

    const db = getDatabase();
    const device = await db.device.findUnique({ where: { id: parsed.deviceId } });
    if (!device || !device.mailTokenHash || device.status !== 'pending') return null;

    // Verify the hash matches
    if (!checkSessionToken(device.mailTokenHash, token)) return null;

    // Verify user exists and device belongs to them
    if (device.userId !== parsed.userId) return null;

    // Activate device
    await db.device.update({
        where: { id: device.id },
        data: { status: 'active', mailTokenHash: null }
    });

    return { userId: parsed.userId, deviceId: parsed.deviceId };
}

// ─── WS Token (short-lived JWT) ─────────────────────────────────────

interface WSTokenPayload {
    userId: string;
    deviceId: string;
}

function generateWSToken(userId: string, deviceId: string): string {
    return jwt.sign({ userId, deviceId } satisfies WSTokenPayload, env.JWT_SECRET, {
        expiresIn: env.WS_TOKEN_EXPIRES_SECONDS
    });
}

function verifyWSToken(token: string): WSTokenPayload | null {
    try {
        const payload = jwt.verify(token, env.JWT_SECRET) as WSTokenPayload;
        if (!payload.userId || !payload.deviceId) return null;
        return { userId: payload.userId, deviceId: payload.deviceId };
    } catch {
        return null;
    }
}

// ─── Exports ─────────────────────────────────────────────────────────

export const tokenManager = {
    hashToken,
    session: {
        generate: generateSessionToken,
        check: checkSessionToken,
        cycle: cycleSessionToken
    },
    mail: {
        generate: generateMailToken,
        parse: parseMailToken,
        confirm: confirmMailToken
    },
    ws: {
        generate: generateWSToken,
        verify: verifyWSToken
    }
};
