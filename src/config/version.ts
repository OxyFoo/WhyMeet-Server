import { readFileSync } from 'fs';
import { resolve } from 'path';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));

export const APP_VERSION: string = pkg.version;
