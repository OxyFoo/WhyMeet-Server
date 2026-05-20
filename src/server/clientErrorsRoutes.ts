import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { logger } from '@/config/logger';

export const clientErrorsRouter = express.Router();

// Per-IP rate limit: keep this generous enough to capture crash storms from a
// single device, but strict enough to prevent flooding our logs from a buggy
// release or a malicious client.
const clientErrorsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

const MAX_STRING = 4_000;
const MAX_CONTEXT_BYTES = 8_000;

function clip(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    return value.length > max ? value.slice(0, max) + '…' : value;
}

function clipContext(value: unknown): Record<string, unknown> | undefined {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    try {
        const json = JSON.stringify(value);
        if (json.length > MAX_CONTEXT_BYTES) {
            return { _truncated: true, _preview: json.slice(0, MAX_CONTEXT_BYTES) };
        }
        return value as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

clientErrorsRouter.post('/', clientErrorsLimiter, (req, res) => {
    const body = req.body ?? {};

    const message = clip(body.message, MAX_STRING) ?? '<no message>';
    const stack = clip(body.stack, MAX_STRING);
    const source = clip(body.source, 200);
    const platform = clip(body.platform, 32);
    const appVersion = clip(body.appVersion, 32);
    const userId = clip(body.userId, 64);
    const isFatal = body.isFatal === true;
    const context = clipContext(body.context);

    logger.error('[ClientError]', {
        message,
        stack,
        source,
        platform,
        appVersion,
        userId,
        isFatal,
        context
    });

    res.status(204).end();
});
