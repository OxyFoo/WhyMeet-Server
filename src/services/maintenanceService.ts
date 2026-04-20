import fs from 'fs';

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
