import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'crypto';
import { getDatabase } from '@/services/database';
import { tokenManager } from '@/services/tokenManager';
import { uploadFile, deleteFile } from '@/services/storageService';
import { logger } from '@/config/logger';
import { env } from '@/config/env';

export const uploadRouter = Router();

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.UPLOAD_MAX_SIZE },
    fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG and WebP are allowed.'));
        }
    }
});

/**
 * POST /upload/avatar
 * Headers: x-device-uuid, x-session-token
 * Body: multipart form-data with "avatar" field
 * Returns: { url: string }
 */
uploadRouter.post('/avatar', uploadLimiter, upload.single('avatar'), async (req, res) => {
    const deviceUUID = req.headers['x-device-uuid'] as string | undefined;
    const sessionToken = req.headers['x-session-token'] as string | undefined;

    if (!deviceUUID || !sessionToken) {
        res.status(401).json({ error: 'Missing credentials' });
        return;
    }

    // Authenticate device
    const db = getDatabase();
    const device = await db.device.findUnique({ where: { uuid: deviceUUID } });
    if (!device || device.status !== 'active' || !device.userId) {
        res.status(401).json({ error: 'Invalid device' });
        return;
    }

    const isValid = tokenManager.session.check(device.sessionTokenHash, sessionToken);
    if (!isValid) {
        res.status(401).json({ error: 'Invalid session' });
        return;
    }

    if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
    }

    try {
        // Process image: resize and convert to webp
        const processed = await sharp(req.file.buffer)
            .resize(800, 800, { fit: 'cover', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();

        const key = `avatars/${device.userId}/${crypto.randomUUID()}.webp`;

        const storedKey = await uploadFile(processed, key, 'image/webp');
        if (!storedKey) {
            res.status(503).json({ error: 'Storage service unavailable' });
            return;
        }

        // Delete old avatar from S3 if exists
        const user = await db.user.findUnique({
            where: { id: device.userId },
            select: { avatar: true }
        });
        if (user?.avatar) {
            deleteFile(user.avatar).catch(() => {});
        }

        // Update avatar key in database
        await db.user.update({
            where: { id: device.userId },
            data: { avatar: storedKey }
        });

        logger.info(`[Upload] Avatar updated for user ${device.userId}`);
        res.json({ url: storedKey });
    } catch (error) {
        logger.error('[Upload] Avatar upload error', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Handle multer errors (file too large, etc.)
uploadRouter.use(
    (
        err: Error,
        _req: import('express').Request,
        res: import('express').Response,
        _next: import('express').NextFunction
    ) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                res.status(413).json({ error: 'File too large' });
                return;
            }
            res.status(400).json({ error: err.message });
            return;
        }
        if (err.message?.includes('Invalid file type')) {
            res.status(400).json({ error: err.message });
            return;
        }
        res.status(500).json({ error: 'Internal error' });
    }
);
