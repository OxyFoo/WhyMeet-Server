import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'crypto';
import { getDatabase } from '@/services/database';
import { tokenManager } from '@/services/tokenManager';
import { uploadFile, deleteFile } from '@/services/storageService';
import { invalidateCandidate } from '@/services/candidateCache';
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

const MAX_PHOTOS = 6;

/**
 * Authenticates a device from request headers.
 * Returns the userId or sends an error response and returns null.
 */
async function authenticateDevice(
    req: Request,
    res: Response
): Promise<{ userId: string; db: ReturnType<typeof getDatabase> } | null> {
    const deviceUUID = req.headers['x-device-uuid'] as string | undefined;
    const sessionToken = req.headers['x-session-token'] as string | undefined;

    if (!deviceUUID || !sessionToken) {
        res.status(401).json({ error: 'Missing credentials' });
        return null;
    }

    const db = getDatabase();
    const device = await db.device.findUnique({ where: { uuid: deviceUUID } });
    if (!device || device.status !== 'active' || !device.userId) {
        res.status(401).json({ error: 'Invalid device' });
        return null;
    }

    const isValid = tokenManager.session.check(device.sessionTokenHash, sessionToken);
    if (!isValid) {
        res.status(401).json({ error: 'Invalid session' });
        return null;
    }

    return { userId: device.userId, db };
}

/**
 * POST /upload/photo
 * Headers: x-device-uuid, x-session-token
 * Body: multipart form-data with "photo" field + optional "description" text field
 * Returns: { photo: ProfilePhoto }
 */
uploadRouter.post('/photo', uploadLimiter, upload.single('photo'), async (req, res) => {
    const auth = await authenticateDevice(req, res);
    if (!auth) return;
    const { userId, db } = auth;

    if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
    }

    try {
        // Check photo count limit
        const count = await db.profilePhoto.count({ where: { userId } });
        if (count >= MAX_PHOTOS) {
            res.status(400).json({ error: `Maximum ${MAX_PHOTOS} photos allowed` });
            return;
        }

        // Process image: resize and convert to webp
        const processed = await sharp(req.file.buffer)
            .resize(800, 800, { fit: 'cover', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();

        const key = `photos/${userId}/${crypto.randomUUID()}.webp`;

        const storedKey = await uploadFile(processed, key, 'image/webp');
        if (!storedKey) {
            res.status(503).json({ error: 'Storage service unavailable' });
            return;
        }

        const description = typeof req.body.description === 'string' ? req.body.description.slice(0, 128) : '';

        const photo = await db.profilePhoto.create({
            data: {
                userId,
                key: storedKey,
                description,
                position: count // append at end
            }
        });

        logger.info(`[Upload] Photo added for user ${userId} (position ${count})`);
        invalidateCandidate(userId).catch(() => {});
        res.json({ photo: { id: photo.id, key: photo.key, description: photo.description, position: photo.position } });
    } catch (error) {
        logger.error('[Upload] Photo upload error', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

/**
 * DELETE /upload/photo/:id
 * Headers: x-device-uuid, x-session-token
 */
uploadRouter.delete('/photo/:id', uploadLimiter, async (req, res) => {
    const auth = await authenticateDevice(req, res);
    if (!auth) return;
    const { userId, db } = auth;

    try {
        const photo = await db.profilePhoto.findUnique({ where: { id: req.params.id as string } });
        if (!photo || photo.userId !== userId) {
            res.status(404).json({ error: 'Photo not found' });
            return;
        }

        // Prevent deleting last photo
        const count = await db.profilePhoto.count({ where: { userId } });
        if (count <= 1) {
            res.status(400).json({ error: 'Cannot delete your last photo' });
            return;
        }

        // Delete from S3
        deleteFile(photo.key).catch(() => {});

        // Delete from DB
        await db.profilePhoto.delete({ where: { id: photo.id } });

        // Re-normalize positions
        const remaining = await db.profilePhoto.findMany({
            where: { userId },
            orderBy: { position: 'asc' }
        });
        for (let i = 0; i < remaining.length; i++) {
            if (remaining[i].position !== i) {
                await db.profilePhoto.update({ where: { id: remaining[i].id }, data: { position: i } });
            }
        }

        logger.info(`[Upload] Photo ${photo.id} deleted for user ${userId}`);
        invalidateCandidate(userId).catch(() => {});
        res.json({ success: true });
    } catch (error) {
        logger.error('[Upload] Photo delete error', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

/**
 * POST /upload/reorder-photos
 * Headers: x-device-uuid, x-session-token
 * Body: { photos: { id: string; position: number }[] }
 */
uploadRouter.post('/reorder-photos', uploadLimiter, async (req, res) => {
    const auth = await authenticateDevice(req, res);
    if (!auth) return;
    const { userId, db } = auth;

    const { photos } = req.body as { photos?: { id: string; position: number }[] };
    if (!Array.isArray(photos) || photos.length === 0) {
        res.status(400).json({ error: 'Missing photos array' });
        return;
    }

    // Validate positions: must be non-negative integers, unique, and cover [0, n-1]
    const positions = photos.map((p) => p.position);
    const validPositions = positions.every((pos) => Number.isInteger(pos) && pos >= 0 && pos < photos.length);
    const uniquePositions = new Set(positions).size === positions.length;
    if (!validPositions || !uniquePositions) {
        res.status(400).json({ error: 'Invalid photo positions' });
        return;
    }

    try {
        // Verify all photos belong to user
        const userPhotos = await db.profilePhoto.findMany({ where: { userId } });
        const userPhotoIds = new Set(userPhotos.map((p) => p.id));

        for (const item of photos) {
            if (!userPhotoIds.has(item.id)) {
                res.status(400).json({ error: `Photo ${item.id} not found` });
                return;
            }
        }

        // Update positions
        for (const item of photos) {
            await db.profilePhoto.update({
                where: { id: item.id },
                data: { position: item.position }
            });
        }

        logger.info(`[Upload] Photos reordered for user ${userId}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Upload] Reorder error', error);
        res.status(500).json({ error: 'Reorder failed' });
    }
});

/**
 * PATCH /upload/photo/:id
 * Headers: x-device-uuid, x-session-token
 * Body: { description: string }
 */
uploadRouter.patch('/photo/:id', uploadLimiter, async (req, res) => {
    const auth = await authenticateDevice(req, res);
    if (!auth) return;
    const { userId, db } = auth;

    const { description } = req.body as { description?: string };
    if (typeof description !== 'string') {
        res.status(400).json({ error: 'Missing description' });
        return;
    }

    try {
        const photo = await db.profilePhoto.findUnique({ where: { id: req.params.id as string } });
        if (!photo || photo.userId !== userId) {
            res.status(404).json({ error: 'Photo not found' });
            return;
        }

        const updated = await db.profilePhoto.update({
            where: { id: photo.id },
            data: { description: description.slice(0, 128) }
        });

        logger.info(`[Upload] Photo ${photo.id} description updated for user ${userId}`);
        res.json({
            photo: { id: updated.id, key: updated.key, description: updated.description, position: updated.position }
        });
    } catch (error) {
        logger.error('[Upload] Photo update error', error);
        res.status(500).json({ error: 'Update failed' });
    }
});

const MAX_ACTIVITY_PHOTOS = 5;

/**
 * POST /upload/activity-photo
 * Headers: x-device-uuid, x-session-token
 * Body: multipart form-data with "photo" field + "activityId" text field
 * Returns: { photo: { id, key, position } }
 */
uploadRouter.post('/activity-photo', uploadLimiter, upload.single('photo'), async (req, res) => {
    const auth = await authenticateDevice(req, res);
    if (!auth) return;
    const { userId, db } = auth;

    const activityId = typeof req.body.activityId === 'string' ? req.body.activityId : '';
    if (!activityId) {
        res.status(400).json({ error: 'Missing activityId' });
        return;
    }

    if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
    }

    try {
        // Verify user is the activity host
        const activity = await db.activity.findUnique({ where: { id: activityId } });
        if (!activity || activity.hostId !== userId) {
            res.status(403).json({ error: 'Only the host can upload photos' });
            return;
        }

        const count = await db.activityPhoto.count({ where: { activityId } });
        if (count >= MAX_ACTIVITY_PHOTOS) {
            res.status(400).json({ error: `Maximum ${MAX_ACTIVITY_PHOTOS} photos allowed` });
            return;
        }

        const processed = await sharp(req.file.buffer)
            .resize(1200, 800, { fit: 'cover', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();

        const key = `activities/${activityId}/${crypto.randomUUID()}.webp`;

        const storedKey = await uploadFile(processed, key, 'image/webp');
        if (!storedKey) {
            res.status(503).json({ error: 'Storage service unavailable' });
            return;
        }

        const photo = await db.activityPhoto.create({
            data: {
                activityId,
                key: storedKey,
                position: count
            }
        });

        logger.info(`[Upload] Activity photo added for activity ${activityId} by user ${userId}`);
        res.json({ photo: { id: photo.id, key: photo.key, position: photo.position } });
    } catch (error) {
        logger.error('[Upload] Activity photo upload error', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

/**
 * DELETE /upload/activity-photo/:id
 * Headers: x-device-uuid, x-session-token
 * Body: { activityId: string }
 */
uploadRouter.delete('/activity-photo/:id', uploadLimiter, async (req, res) => {
    const auth = await authenticateDevice(req, res);
    if (!auth) return;
    const { userId, db } = auth;

    const activityId = typeof req.body?.activityId === 'string' ? req.body.activityId : '';
    if (!activityId) {
        res.status(400).json({ error: 'Missing activityId' });
        return;
    }

    try {
        const activity = await db.activity.findUnique({ where: { id: activityId } });
        if (!activity || activity.hostId !== userId) {
            res.status(403).json({ error: 'Only the host can delete activity photos' });
            return;
        }

        const photo = await db.activityPhoto.findUnique({ where: { id: req.params.id as string } });
        if (!photo || photo.activityId !== activityId) {
            res.status(404).json({ error: 'Photo not found' });
            return;
        }

        deleteFile(photo.key).catch(() => {});

        await db.activityPhoto.delete({ where: { id: photo.id } });

        // Re-normalize positions
        const remaining = await db.activityPhoto.findMany({
            where: { activityId },
            orderBy: { position: 'asc' }
        });
        for (let i = 0; i < remaining.length; i++) {
            if (remaining[i].position !== i) {
                await db.activityPhoto.update({ where: { id: remaining[i].id }, data: { position: i } });
            }
        }

        logger.info(`[Upload] Activity photo ${photo.id} deleted for activity ${activityId} by user ${userId}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Upload] Activity photo delete error', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

/**
 * POST /upload/reorder-activity-photos
 * Headers: x-device-uuid, x-session-token
 * Body: { activityId: string; photos: { id: string; position: number }[] }
 */
uploadRouter.post('/reorder-activity-photos', uploadLimiter, async (req, res) => {
    const auth = await authenticateDevice(req, res);
    if (!auth) return;
    const { userId, db } = auth;

    const { activityId, photos } = req.body as {
        activityId?: string;
        photos?: { id: string; position: number }[];
    };
    if (!activityId || !Array.isArray(photos) || photos.length === 0) {
        res.status(400).json({ error: 'Missing activityId or photos array' });
        return;
    }

    const positions = photos.map((p) => p.position);
    const validPositions = positions.every((pos) => Number.isInteger(pos) && pos >= 0 && pos < photos.length);
    const uniquePositions = new Set(positions).size === positions.length;
    if (!validPositions || !uniquePositions) {
        res.status(400).json({ error: 'Invalid photo positions' });
        return;
    }

    try {
        const activity = await db.activity.findUnique({ where: { id: activityId } });
        if (!activity || activity.hostId !== userId) {
            res.status(403).json({ error: 'Only the host can reorder activity photos' });
            return;
        }

        const activityPhotos = await db.activityPhoto.findMany({ where: { activityId } });
        const activityPhotoIds = new Set(activityPhotos.map((p) => p.id));

        for (const item of photos) {
            if (!activityPhotoIds.has(item.id)) {
                res.status(400).json({ error: `Photo ${item.id} not found` });
                return;
            }
        }

        for (const item of photos) {
            await db.activityPhoto.update({
                where: { id: item.id },
                data: { position: item.position }
            });
        }

        logger.info(`[Upload] Activity photos reordered for activity ${activityId} by user ${userId}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('[Upload] Activity photos reorder error', error);
        res.status(500).json({ error: 'Reorder failed' });
    }
});

// Handle multer errors (file too large, etc.)
uploadRouter.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
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
});
