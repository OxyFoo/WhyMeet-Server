import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetIntentionCatalog, WSResponse_GetIntentionCatalog } from '@oxyfoo/whymeet-types';
import { INTENTIONS, INTENTION_CATEGORIES } from '@oxyfoo/whymeet-types';

registerCommand<WSRequest_GetIntentionCatalog>(
    'get-intention-catalog',
    async (_client: Client): Promise<WSResponse_GetIntentionCatalog> => {
        return {
            command: 'get-intention-catalog',
            payload: { categories: [...INTENTION_CATEGORIES], intentions: [...INTENTIONS] }
        };
    }
);
