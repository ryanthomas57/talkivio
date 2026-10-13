/**
 * Minimal .env loader (no dependency). Loads apps/api/.env then repo-root .env
 * without overriding variables that are already set.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parse(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFiles(): void {
  const candidates = [resolve(__dirname, '../../.env'), resolve(__dirname, '../../../../.env')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const vars = parse(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvFiles();
