import fs from 'fs';
import path from 'path';

const FLAG_PATH = '/tmp/whymeet-maintenance.flag';
const CACHE_TTL_MS = 10_000;

let cachedFlag = false;
let lastCheck = 0;

function checkFlagFile(): boolean {
    const now = Date.now();
    if (now - lastCheck < CACHE_TTL_MS) return cachedFlag;
    lastCheck = now;
    cachedFlag = fs.existsSync(FLAG_PATH);
    return cachedFlag;
}

export function isMaintenanceMode(): boolean {
    return checkFlagFile();
}

export function setMaintenanceMode(enabled: boolean): void {
    try {
        if (enabled) {
            fs.mkdirSync(path.dirname(FLAG_PATH), { recursive: true });
            fs.writeFileSync(FLAG_PATH, new Date().toISOString(), 'utf8');
        } else if (fs.existsSync(FLAG_PATH)) {
            fs.unlinkSync(FLAG_PATH);
        }
    } finally {
        cachedFlag = enabled;
        lastCheck = Date.now();
    }
}
