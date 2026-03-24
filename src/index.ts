import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { connectDatabase, disconnectDatabase } from '@/services/database';
import { startServer, stopServer } from '@/server/Server';
import { getRegisteredCommands } from '@/server/Router';

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Register all commands
import '@/commands';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));

async function main(): Promise<void> {
    logger.info(`[WhyMeet Server] v${pkg.version} (${env.ENVIRONMENT})`);

    // Connect to database
    const dbConnected = await connectDatabase();
    if (!dbConnected) {
        logger.error('[Main] Failed to connect to database. Exiting...');
        process.exit(1);
    }

    // Log registered commands
    const commands = getRegisteredCommands();
    logger.info(`[Main] Registered ${commands.length} commands: ${commands.join(', ')}`);

    // Start WebSocket server
    await startServer(env.LISTEN_PORT_WS);
    logger.success(`[Main] All services started successfully`);
}

// Graceful shutdown
let exited = false;
async function onExit(): Promise<void> {
    if (exited) return;
    exited = true;

    logger.info('[Main] Shutting down...');
    await stopServer();
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
