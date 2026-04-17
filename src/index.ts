import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { APP_VERSION } from '@/config/version';
import { connectDatabase, disconnectDatabase } from '@/services/database';
import { initStorage } from '@/services/storageService';
import { startServer, stopServer } from '@/server/Server';
import { getRegisteredCommands } from '@/server/Router';
import { startActivityNotifScheduler, stopActivityNotifScheduler } from '@/services/activityNotifScheduler';
import { connectRedis, disconnectRedis } from '@/services/redisService';

// Register all commands
import '@/commands';

async function main(): Promise<void> {
    logger.info(`[WhyMeet Server] v${APP_VERSION} (${env.ENVIRONMENT})`);

    // Connect to database
    const dbConnected = await connectDatabase();
    if (!dbConnected) {
        logger.error('[Main] Failed to connect to database. Exiting...');
        process.exit(1);
    }

    // Log registered commands
    const commands = getRegisteredCommands();
    logger.info(`[Main] Registered ${commands.length} commands: ${commands.join(', ')}`);

    // Connect to Redis (optional, cache degrades gracefully if unavailable)
    await connectRedis();

    // Initialize S3 storage
    await initStorage();

    // Start WebSocket server
    await startServer(env.LISTEN_PORT_WS);

    // Start activity notification scheduler
    startActivityNotifScheduler();

    logger.success(`[Main] All services started successfully`);
}

// Graceful shutdown
let exited = false;
async function onExit(): Promise<void> {
    if (exited) return;
    exited = true;

    logger.info('[Main] Shutting down...');
    stopActivityNotifScheduler();
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
