import { readFileSync } from 'node:fs';

// Read from apps/server/package.json (next to src/ and dist/) so the release version has one source.
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
