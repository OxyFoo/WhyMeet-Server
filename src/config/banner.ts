import os from 'os';
import { env } from '@/config/env';
import { APP_VERSION } from '@/config/version';
import { c, shouldLog } from '@/config/logger';

const BOX_WIDTH = 44;

function pad(text: string, width: number): string {
    const visible = text.replace(/\x1b\[[0-9;]*m/g, '');
    const padding = Math.max(0, width - visible.length);
    return text + ' '.repeat(padding);
}

function getLocalIp(): string {
    const interfaces = os.networkInterfaces();
    for (const nets of Object.values(interfaces)) {
        if (!nets) continue;
        for (const net of nets) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return '0.0.0.0';
}

export function printBanner(): void {
    if (!shouldLog('normal')) return;

    const inner = BOX_WIDTH - 4; // 2 border + 2 padding
    const ip = getLocalIp();

    const lines = [
        `${c.bold}WhyMeet Server${c.reset}${c.cyan}  v${APP_VERSION}`,
        `${env.ENVIRONMENT === 'prod' ? `${c.red}Production` : `${c.green}Development`}${c.reset}${c.cyan}  ·  Port ${c.white}${env.LISTEN_PORT_WS}${c.cyan}  ·  ${c.white}${ip}${c.cyan}`
    ];

    console.log('');
    console.log(`${c.cyan}  ┌${'─'.repeat(BOX_WIDTH - 2)}┐${c.reset}`);
    for (const line of lines) {
        console.log(`${c.cyan}  │ ${pad(line, inner)} ${c.cyan}│${c.reset}`);
    }
    console.log(`${c.cyan}  └${'─'.repeat(BOX_WIDTH - 2)}┘${c.reset}`);
    console.log('');
}

type ServiceStatus = 'ok' | 'warn' | 'fail';

const STATUS_ICONS: Record<ServiceStatus, string> = {
    ok: `${c.green}  ✓${c.reset}`,
    warn: `${c.yellow}  ⚠${c.reset}`,
    fail: `${c.red}  ✗${c.reset}`
};

export function printService(name: string, status: ServiceStatus, detail: string): void {
    if (!shouldLog('normal')) return;
    const icon = STATUS_ICONS[status];
    const color = status === 'ok' ? c.white : status === 'warn' ? c.yellow : c.red;
    const dimDetail = status === 'warn' ? `${c.dim}${detail}${c.reset}` : `${color}${detail}${c.reset}`;
    console.log(`${icon} ${c.bold}${pad(name, 20)}${c.reset} ${dimDetail}`);
}

export function printReady(commandCount: number): void {
    if (!shouldLog('normal')) return;
    console.log('');
    console.log(`${c.green}  ✓ Ready${c.reset}${c.dim} — ${commandCount} commands registered${c.reset}`);
    console.log(`${c.dim}  ${'─'.repeat(BOX_WIDTH - 4)}${c.reset}`);
    console.log('');
}
