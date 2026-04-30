import { z } from 'zod';
import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_PlacesSuggest, WSResponse_PlacesSuggest } from '@oxyfoo/whymeet-types';
import { searchPlaces, MapboxDisabledError } from '@/services/placesService';
import { logger } from '@/config/logger';

const placesSuggestSchema = z.object({
    query: z.string().min(1).max(100),
    language: z.string().min(2).max(5).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional()
});

registerCommand<WSRequest_PlacesSuggest>(
    'places-suggest',
    async (client: Client, payload): Promise<WSResponse_PlacesSuggest> => {
        const parsed = placesSuggestSchema.safeParse(payload);
        if (!parsed.success) {
            const msg = parsed.error.errors[0]?.message ?? 'Invalid payload';
            return { command: 'places-suggest', payload: { error: msg } };
        }

        try {
            const suggestions = await searchPlaces({
                query: parsed.data.query,
                language: parsed.data.language,
                latitude: parsed.data.latitude,
                longitude: parsed.data.longitude,
                userId: client.userId
            });
            return { command: 'places-suggest', payload: { suggestions } };
        } catch (error) {
            if (error instanceof MapboxDisabledError) {
                return { command: 'places-suggest', payload: { error: 'mapbox_disabled' } };
            }
            logger.error('[Places] Suggest error', error);
            return { command: 'places-suggest', payload: { error: 'Internal error' } };
        }
    }
);
