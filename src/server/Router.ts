import type { WSClientCommand, WSClientRequest, WSServerResponse } from '@whymeet/types';
import type { Client } from './Client';
import { logger } from '@/config/logger';

export type CommandHandler<T extends WSClientRequest = WSClientRequest> = (
    client: Client,
    payload: T['payload']
) => Promise<WSServerResponse>;

const handlers = new Map<WSClientCommand, CommandHandler>();

export function registerCommand<T extends WSClientRequest>(command: T['command'], handler: CommandHandler<T>): void {
    if (handlers.has(command)) {
        logger.warn(`[Router] Command '${command}' already registered, overwriting`);
    }
    handlers.set(command, handler as CommandHandler);
    logger.debug(`[Router] Registered command: ${command}`);
}

export async function routeCommand(client: Client, request: WSClientRequest): Promise<WSServerResponse | null> {
    const handler = handlers.get(request.command);
    if (!handler) {
        logger.warn(`[Router] Unknown command: ${request.command}`);
        return null;
    }

    try {
        return await handler(client, request.payload);
    } catch (error) {
        logger.error(`[Router] Error handling '${request.command}'`, error);
        return null;
    }
}

export function getRegisteredCommands(): WSClientCommand[] {
    return Array.from(handlers.keys());
}
