import { env } from './env';

type LogLevel = 'minimal' | 'normal' | 'all';

const LEVELS: Record<LogLevel, number> = { minimal: 0, normal: 1, all: 2 };

export function shouldLog(required: LogLevel): boolean {
    return LEVELS[env.LOG_LEVEL] >= LEVELS[required];
}

const timestamp = () => new Date().toISOString();

// ANSI color helpers (no external dependency)
export const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    white: '\x1b[37m'
};

export const logger = {
    error: (msg: string, ...args: unknown[]) => {
        console.error(`[${timestamp()}] ERROR: ${msg}`, ...args);
    },
    warn: (msg: string, ...args: unknown[]) => {
        if (shouldLog('minimal')) console.warn(`[${timestamp()}] WARN: ${msg}`, ...args);
    },
    info: (msg: string, ...args: unknown[]) => {
        if (shouldLog('normal')) console.log(`[${timestamp()}] INFO: ${msg}`, ...args);
    },
    debug: (msg: string, ...args: unknown[]) => {
        if (shouldLog('all')) console.debug(`[${timestamp()}] DEBUG: ${msg}`, ...args);
    },
    success: (msg: string, ...args: unknown[]) => {
        if (shouldLog('normal')) console.log(`[${timestamp()}] ✓ ${msg}`, ...args);
    }
};
