import type { CDPSession, Page } from '@playwright/test';

/**
 * Main-thread stall diagnostics. A page.evaluate or key press that never returns means the renderer's main thread is
 * blocked (an endless loop in page code); without this the test sits silent until its own timeout. Debugger.pause
 * interrupts running JavaScript where an evaluate cannot, but only on a session whose Debugger domain was enabled
 * before the stall (enabling it afterwards waits for the blocked thread too), so watchMainThread() attaches when the
 * test starts. guarded() then fails the step after STALL_MS with the paused main-thread stack instead of hanging.
 */
export const STALL_MS = 15_000;

type Watch = { cdp: CDPSession; urls: Map<string, string>; pausing: boolean };
type PausedFrame = {
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
};
const watches = new WeakMap<Page, Watch>();

export async function watchMainThread(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const watch: Watch = { cdp, urls: new Map(), pausing: false };
  cdp.on('Debugger.scriptParsed', (e) => watch.urls.set(e.scriptId, e.url));
  // Only the stall dump may stop the page: anything else (a stray `debugger` statement) resumes at once.
  cdp.on('Debugger.paused', () => {
    if (!watch.pausing) void cdp.send('Debugger.resume').catch(() => undefined);
  });
  await cdp.send('Debugger.enable');
  watches.set(page, watch);
}

/** Runs one page step; if the page does not answer within STALL_MS, fails with what its main thread is executing. */
export async function guarded<T>(page: Page, step: string, run: () => Promise<T>): Promise<T> {
  const watch = watches.get(page);
  if (!watch) return run();
  const STALLED = Symbol('stalled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<typeof STALLED>((resolve) => {
    timer = setTimeout(() => resolve(STALLED), STALL_MS);
  });
  const result = await Promise.race([run(), stalled]).finally(() => clearTimeout(timer));
  if (result !== STALLED) return result as T;
  throw new Error(
    `${step}: the page did not respond for ${STALL_MS / 1000} s, so its main thread is blocked. ` +
      `Main-thread stack (paused):\n${await mainThreadStack(watch)}`,
  );
}

async function mainThreadStack(watch: Watch): Promise<string> {
  const { cdp } = watch;
  watch.pausing = true;
  const paused = new Promise<{ callFrames: PausedFrame[] }>((resolve) =>
    cdp.once('Debugger.paused', resolve),
  );
  await cdp.send('Debugger.pause');
  const event = await Promise.race([paused, new Promise<null>((r) => setTimeout(() => r(null), 5_000))]);
  if (!event) return '  (the page did not pause)';
  const lines: string[] = [];
  for (const frame of event.callFrames.slice(0, 15)) {
    const { scriptId, lineNumber, columnNumber = 0 } = frame.location;
    const source = await cdp.send('Debugger.getScriptSource', { scriptId }).catch(() => null);
    // Production chunks are minified: the code around the position says more than the function name.
    const line = source?.scriptSource.split('\n')[lineNumber];
    const code = line?.slice(Math.max(0, columnNumber - 80), columnNumber + 120);
    const url = (watch.urls.get(scriptId) ?? '').replace(/^https?:\/\/[^/]+/, '');
    lines.push(`  at ${frame.functionName || '(anonymous)'} (${url}:${lineNumber + 1}:${columnNumber + 1})`);
    if (code) lines.push(`     ${JSON.stringify(code)}`);
  }
  return lines.join('\n');
}
