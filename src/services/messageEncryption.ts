import crypto from 'crypto';
import { env } from '@/config/env';
import { logger } from '@/config/logger';

/**
 * AES-256-GCM symmetric encryption for message contents at rest.
 *
 * The key is loaded from `CRYPT_KEY_MESSAGES` (64 hex chars → 32 bytes).
 * Ciphertext format: `${ivHex}:${authTagHex}:${cipherHex}` where `iv` is 12 bytes.
 *
 * Encrypted blobs are stored in the `messages.text` column. The plaintext is
 * never persisted. Decryption only happens server-side, either when the
 * recipient fetches their conversation messages (mobile app) or when an
 * admin/moderator pulls them through the audited /admin endpoint.
 */

const KEY_HEX_LENGTH = 64; // 32 bytes
const IV_BYTES = 12;
const ALGO = 'aes-256-gcm' as const;

function getKey(): Buffer {
    const hex = env.CRYPT_KEY_MESSAGES;
    if (!hex || hex.length !== KEY_HEX_LENGTH) {
        throw new Error('CRYPT_KEY_MESSAGES must be 64 hex chars (32 bytes)');
    }
    return Buffer.from(hex, 'hex');
}

export function encryptText(plain: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptText(blob: string): string {
    const parts = blob.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted message format');
    }
    const [ivHex, authTagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
}

/**
 * Best-effort decrypt: returns empty string and logs a warning on failure.
 * Use this for read paths (get-messages, admin endpoint) so a single bad row
 * cannot break the whole listing.
 */
export function safeDecryptText(blob: string): string {
    if (!blob) return '';
    try {
        return decryptText(blob);
    } catch (err) {
        logger.warn('[MessageEncryption] Failed to decrypt message', err);
        return '';
    }
}
