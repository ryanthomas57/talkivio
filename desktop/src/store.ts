/** Small persisted app state (window position, one-time hints) in the user's app data folder. */
import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface State {
  bounds?: Bounds;
  maximized?: boolean;
  /** "Still running in the background" was shown after the first window close. */
  closeHintShown?: boolean;
}

const file = () => join(app.getPath('userData'), 'window-state.json');
let cache: State | null = null;

export function readState(): State {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(file(), 'utf8')) as State;
  } catch {
    cache = {};
  }
  return cache;
}

export function writeState(patch: Partial<State>): void {
  cache = { ...readState(), ...patch };
  try {
    writeFileSync(file(), JSON.stringify(cache));
  } catch {
    /* read-only profile: the state lives for this session only */
  }
}
