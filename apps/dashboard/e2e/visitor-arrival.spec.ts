import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { settle } from './routes';

/**
 * A visitor landing on the website alerts the agent wherever they are in the dashboard (here: Overview, not the
 * Visitors page): the arrival chime and, with the dashboard in the background, a desktop notification naming the
 * visitor and the page. A page change on the website is not a new arrival. The visitor is the widget on the demo
 * storefront in its own browser context; audio and notifications are recorded by stubs, and the dashboard reports no
 * focus, as when the agent is working in another application.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const DEMO = process.env.WIDGET_DEMO_URL ?? 'http://localhost:5173';
const ARRIVAL_CHIME = [1046, 784];

type Shown = { title: string; body?: string; tag?: string };

async function csrf(request: APIRequestContext) {
  return {
    'x-csrf-token': (await request.storageState()).cookies.find((c) => c.name === 'rd_csrf')?.value ?? '',
  };
}

const shown = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __notifications: Shown[] }).__notifications.filter(
      (n) => n.tag === 'rd-visitor-arrived',
    ),
  );
const tones = (page: Page) => page.evaluate(() => (window as unknown as { __tones: number[] }).__tones);

test('a visitor arriving on the website chimes and shows a desktop notification on any dashboard page', async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const headers = await csrf(request);
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Array<{
    public_key: string;
    origins: Array<{ origin: string }>;
  }>;
  const site = sites.find((s) => s.origins?.some((o) => o.origin === DEMO));
  test.skip(!site, 'no site lists the widget demo origin');
  const prefsBefore = (await (await request.get(`${API}/api/v1/agents/me`)).json()).data
    .preferences as Record<string, unknown>;
  const prefs = { sound: true, desktop_notifications: true, visitor_alerts: true, privacy_mode: false };
  expect((await request.patch(`${API}/api/v1/agents/me/preferences`, { data: prefs, headers })).ok()).toBe(
    true,
  );
  // Only listed visitors alert: a workspace from before consent became opt-in still hides visitors without it.
  const setConsentRequired = async (required: boolean) => {
    const t = (await (await request.get(`${API}/api/v1/tenants/current`)).json()).data;
    const res = await request.patch(`${API}/api/v1/tenants/current`, {
      data: { settings: { tracking: { analytics_consent_required: required } }, expected_version: t.version },
      headers,
    });
    expect(res.ok(), `analytics_consent_required=${required}`).toBe(true);
    return t.settings?.tracking?.analytics_consent_required === true;
  };
  const consentWasRequired = await setConsentRequired(false);

  await page.addInitScript(() => {
    const notes: Shown[] = [];
    const freqs: number[] = [];
    Object.assign(window, { __notifications: notes, __tones: freqs });
    class RecordedNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: { body?: string; tag?: string }) {
        notes.push({ title, body: opts?.body, tag: opts?.tag });
      }
      close() {}
    }
    const node = () => ({ connect: (next: unknown) => next });
    class RecordedAudio {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume() {
        return Promise.resolve();
      }
      createGain() {
        return {
          ...node(),
          gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
        };
      }
      createOscillator() {
        const osc = {
          ...node(),
          type: 'sine',
          frequency: { value: 0 },
          start: () => freqs.push(osc.frequency.value),
          stop() {},
        };
        return osc;
      }
    }
    Object.assign(window, { Notification: RecordedNotification, AudioContext: RecordedAudio });
    document.hasFocus = () => false;
  });
  await page.goto('/overview');
  await settle(page);

  const vctx = await browser.newContext({ storageState: undefined });
  try {
    const vpage = await vctx.newPage();
    const host = `${DEMO}/sdk-host.html?${new URLSearchParams({ key: site!.public_key, api: API })}`;
    await vpage.goto(host);
    await expect
      .poll(() => shown(page), { timeout: 30_000, message: 'the arrival notification' })
      .toHaveLength(1);
    const [note] = await shown(page);
    expect(note!.title).toBe('New visitor on your website');
    expect(note!.body, 'names the visitor and the page').toMatch(/ is on /);
    expect(await tones(page), 'the arrival chime played').toEqual(expect.arrayContaining(ARRIVAL_CHIME));

    // A page change on the website (here a reload, after the alert's rate limit) is the same visit: no new alert.
    await page.waitForTimeout(5_000);
    await vpage.reload();
    await vpage.waitForFunction(
      () =>
        (window as unknown as { Talkivio?: (c: string) => { connection: string } }).Talkivio?.('getState')
          ?.connection === 'connected',
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(5_000);
    expect(await shown(page), 'still one notification after the page change').toHaveLength(1);
  } finally {
    await vctx.close();
    await request.patch(`${API}/api/v1/agents/me/preferences`, {
      data: {
        sound: prefsBefore.sound ?? true,
        desktop_notifications: prefsBefore.desktop_notifications ?? true,
        visitor_alerts: prefsBefore.visitor_alerts ?? true,
        privacy_mode: prefsBefore.privacy_mode ?? false,
      },
      headers,
    });
    if (consentWasRequired) await setConsentRequired(true);
  }
});
