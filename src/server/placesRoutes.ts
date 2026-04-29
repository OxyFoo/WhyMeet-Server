import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { logger } from '@/config/logger';
import { fetchStaticMap, MapboxDisabledError } from '@/services/placesService';

export const placesRouter = express.Router();

// Static-map proxy: hides the Mapbox token. Accepts only sensible numeric ranges.
const staticMapLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

placesRouter.get('/static-map', staticMapLimiter, async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const zoom = req.query.zoom != null ? Number(req.query.zoom) : 14;
    const width = req.query.w != null ? Number(req.query.w) : 600;
    const height = req.query.h != null ? Number(req.query.h) : 300;
    const retina = req.query.retina === '1' || req.query.retina === 'true';

    if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180 ||
        !Number.isFinite(zoom) ||
        zoom < 0 ||
        zoom > 22 ||
        !Number.isFinite(width) ||
        width < 64 ||
        width > 1280 ||
        !Number.isFinite(height) ||
        height < 64 ||
        height > 1280
    ) {
        res.status(400).json({ error: 'invalid_parameters' });
        return;
    }

    try {
        const { buffer, contentType } = await fetchStaticMap({
            latitude: lat,
            longitude: lng,
            zoom,
            width,
            height,
            retina
        });
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buffer);
    } catch (err) {
        if (err instanceof MapboxDisabledError) {
            res.status(503).json({ error: 'mapbox_disabled' });
            return;
        }
        logger.warn('[Places] static-map proxy failed', err);
        res.status(502).json({ error: 'upstream_error' });
    }
});
