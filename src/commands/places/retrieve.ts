import { z } from 'zod';
import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_PlacesRetrieve, WSResponse_PlacesRetrieve } from '@oxyfoo/whymeet-types';
import { retrievePlace, MapboxDisabledError } from '@/services/placesService';
import { logger } from '@/config/logger';

const placesRetrieveSchema = z.object({
    id: z.string().min(1).max(256),
    language: z.string().min(2).max(5).optional()
});

registerCommand<WSRequest_PlacesRetrieve>(
    'places-retrieve',
    async (client: Client, payload): Promise<WSResponse_PlacesRetrieve> => {
        const parsed = placesRetrieveSchema.safeParse(payload);
        if (!parsed.success) {
            const msg = parsed.error.errors[0]?.message ?? 'Invalid payload';
            return { command: 'places-retrieve', payload: { error: msg } };
        }

        try {
            const place = await retrievePlace({
                id: parsed.data.id,
                language: parsed.data.language,
                userId: client.userId
            });
            return { command: 'places-retrieve', payload: { place } };
        } catch (error) {
            if (error instanceof MapboxDisabledError) {
                return { command: 'places-retrieve', payload: { error: 'mapbox_disabled' } };
            }
            logger.error('[Places] Retrieve error', error);
            return { command: 'places-retrieve', payload: { error: 'Internal error' } };
        }
    }
);
