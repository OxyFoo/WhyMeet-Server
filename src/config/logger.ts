import fs from 'fs';
import path from 'path';
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

// ─── File transport (daily rotation, retention via LOG_KEEP_DAYS) ────

const LOG_DIR = path.resolve(env.LOG_PATH);
let currentStreamDate = '';
let currentStream: fs.WriteStream | null = null;

function ensureLogDir(): void {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch {
        // swallow — file logging is best-effort
    }
}

function dateStamp(d = new Date()): string {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function getStream(): fs.WriteStream | null {
    const day = dateStamp();
    if (currentStream && currentStreamDate === day) return currentStream;
    ensureLogDir();
    try {
        if (currentStream) currentStream.end();
        currentStream = fs.createWriteStream(path.join(LOG_DIR, `${day}.log`), { flags: 'a' });
        currentStreamDate = day;
        return currentStream;
    } catch {
        return null;
    }
}

function cleanupOldLogs(): void {
    ensureLogDir();
    try {
        const cutoff = Date.now() - env.LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
        for (const f of fs.readdirSync(LOG_DIR)) {
            if (!f.endsWith('.log')) continue;
            const p = path.join(LOG_DIR, f);
            try {
                const stat = fs.statSync(p);
                if (stat.mtimeMs < cutoff) fs.unlinkSync(p);
            } catch {
                // ignore
            }
        }
    } catch {
        // ignore
    }
}

// Run cleanup on startup and daily thereafter
cleanupOldLogs();
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000).unref();

function writeToFile(level: string, msg: string, args: unknown[]): void {
    const stream = getStream();
    if (!stream) return;
    const extra = args.length
        ? ' ' +
          args
              .map((a) => {
                  if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
                  try {
                      return typeof a === 'string' ? a : JSON.stringify(a);
                  } catch {
                      return String(a);
                  }
              })
              .join(' ')
        : '';
    stream.write(`[${timestamp()}] ${level}: ${msg}${extra}\n`);
}

export interface LogFileEntry {
    name: string;
    sizeBytes: number;
    modifiedAt: string;
}

export function listLogFiles(): LogFileEntry[] {
    ensureLogDir();
    try {
        return fs
            .readdirSync(LOG_DIR)
            .filter((f) => f.endsWith('.log'))
            .map((name) => {
                const stat = fs.statSync(path.join(LOG_DIR, name));
                return { name, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
            })
            .sort((a, b) => (a.name < b.name ? 1 : -1));
    } catch {
        return [];
    }
}

export function readLogFile(name: string, opts: { tailBytes?: number } = {}): string {
    // Guard against path traversal: only allow plain YYYY-MM-DD.log filenames
    if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) throw new Error('invalid_log_name');
    const p = path.join(LOG_DIR, name);
    const real = fs.realpathSync(p);
    if (!real.startsWith(fs.realpathSync(LOG_DIR))) throw new Error('invalid_log_path');
    const stat = fs.statSync(real);
    if (!opts.tailBytes || stat.size <= opts.tailBytes) {
        return fs.readFileSync(real, 'utf8');
    }
    const fd = fs.openSync(real, 'r');
    try {
        const start = stat.size - opts.tailBytes;
        const buf = Buffer.alloc(opts.tailBytes);
        fs.readSync(fd, buf, 0, opts.tailBytes, start);
        return buf.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

export const logger = {
    error: (msg: string, ...args: unknown[]) => {
        console.error(`[${timestamp()}] ERROR: ${msg}`, ...args);
        writeToFile('ERROR', msg, args);
    },
    warn: (msg: string, ...args: unknown[]) => {
        if (shouldLog('minimal')) console.warn(`[${timestamp()}] WARN: ${msg}`, ...args);
        writeToFile('WARN', msg, args);
    },
    info: (msg: string, ...args: unknown[]) => {
        if (shouldLog('normal')) console.log(`[${timestamp()}] INFO: ${msg}`, ...args);
        writeToFile('INFO', msg, args);
    },
    debug: (msg: string, ...args: unknown[]) => {
        if (shouldLog('all')) console.debug(`[${timestamp()}] DEBUG: ${msg}`, ...args);
        if (shouldLog('all')) writeToFile('DEBUG', msg, args);
    },
    success: (msg: string, ...args: unknown[]) => {
        if (shouldLog('normal')) console.log(`[${timestamp()}] ✓ ${msg}`, ...args);
        writeToFile('INFO', msg, args);
    }
};
