import { registerCommand } from '@/server/Router';
import type { Client } from '@/server/Client';
import type { WSRequest_GetAdsConfig, WSResponse_GetAdsConfig } from '@oxyfoo/whymeet-types';
import { getAdsConfig } from '@/services/adsConfigService';
import { logger } from '@/config/logger';

registerCommand<WSRequest_GetAdsConfig>('get-ads-config', async (_client: Client): Promise<WSResponse_GetAdsConfig> => {
    try {
        const config = await getAdsConfig();
        return { command: 'get-ads-config', payload: { config } };
    } catch (error) {
        logger.error('[Ads] Get config error', error);
        return { command: 'get-ads-config', payload: { error: 'Internal error' } };
    }
});
