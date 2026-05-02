import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { printBanner, printService, printReady } from '@/config/banner';
import { connectDatabase, disconnectDatabase } from '@/services/database';
import { initStorage } from '@/services/storageService';
import { startServer, stopServer } from '@/server/Server';
import { getRegisteredCommands } from '@/server/Router';
import { startActivityNotifScheduler, stopActivityNotifScheduler } from '@/services/activityNotifScheduler';
import { startTagPromotionScheduler, stopTagPromotionScheduler } from '@/services/tagPromotion';
import { connectRedis, disconnectRedis } from '@/services/redisService';

// Register all commands
import '@/commands';

async function main(): Promise<void> {
    printBanner();

    // Connect to database (required)
    const dbConnected = await connectDatabase();
    if (!dbConnected) {
        printService('Database', 'fail', 'Connection failed');
        process.exit(1);
    }
    printService('Database', 'ok', 'Connected');

    // Connect to Redis (optional)
    const redisConnected = await connectRedis();
    printService('Redis', redisConnected ? 'ok' : 'warn', redisConnected ? 'Connected' : 'Not configured');

    // Initialize S3 storage (optional)
    const s3Configured = !!(env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY);
    if (s3Configured) {
        await initStorage();
    }
    printService(
        'Storage (S3)',
        s3Configured ? 'ok' : 'warn',
        s3Configured ? `Bucket ${env.S3_BUCKET}` : 'Not configured'
    );

    // Check optional external services
    printService('SMTP', env.SMTP_HOST ? 'ok' : 'warn', env.SMTP_HOST || 'Not configured');
    printService(
        'Firebase (FCM)',
        env.FIREBASE_SERVICE_ACCOUNT ? 'ok' : 'warn',
        env.FIREBASE_SERVICE_ACCOUNT ? 'Configured' : 'Not configured'
    );
    printService('OpenAI', env.OPENAI_API_KEY ? 'ok' : 'warn', env.OPENAI_API_KEY ? 'Configured' : 'Not configured');

    // Start WebSocket server
    await startServer(env.LISTEN_PORT_WS);
    printService('WebSocket', 'ok', `Listening on :${env.LISTEN_PORT_WS}`);

    // Start activity notification scheduler
    startActivityNotifScheduler();
    printService('Scheduler', 'ok', 'Started (900s interval)');

    // Start tag promotion scheduler (canonicalises raw user labels in batch)
    startTagPromotionScheduler();
    printService('TagPromotion', 'ok', 'Started (24h interval)');

    // Final ready message
    const commands = getRegisteredCommands();
    printReady(commands.length);
}

// Graceful shutdown
let exited = false;
async function onExit(): Promise<void> {
    if (exited) return;
    exited = true;

    logger.info('[Main] Shutting down...');
    stopActivityNotifScheduler();
    stopTagPromotionScheduler();
    await stopServer();
    await disconnectRedis();
    await disconnectDatabase();
    logger.info('[Main] Goodbye');
}

process.on('SIGINT', onExit);
process.on('SIGQUIT', onExit);
process.on('SIGTERM', onExit);
process.on('uncaughtException', (error) => {
    logger.error('[Main] Uncaught exception', error);
    onExit();
});

main().catch((error) => {
    logger.error('[Main] Fatal error', error);
    process.exit(1);
});
