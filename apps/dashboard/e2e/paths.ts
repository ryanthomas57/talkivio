import { resolve } from 'node:path';

/**
 * Where the suite keeps its sign-in state and findings. By default both live in the checkout (CI uploads
 * e2e-results as an artifact). E2E_STATE_DIR moves them elsewhere — locally, off a volume that is unsafe for files
 * rewritten during a run (the authoring machine's external exFAT volume has dropped such writes under memory
 * pressure, leaving all-zero files).
 */
const base = process.env.E2E_STATE_DIR ? resolve(process.env.E2E_STATE_DIR) : null;
export const AUTH_FILE = base ? resolve(base, 'auth/owner.json') : 'e2e/.auth/owner.json';
export const RESULTS_DIR = base ? resolve(base, 'results') : 'e2e-results';
