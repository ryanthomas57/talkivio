import { expect, test, type Page } from '@playwright/test';
import { settle, startVisitorChat } from './routes';
import { guarded, watchMainThread } from './stall';

/**
 * A11Y01: keyboard-only agent journey — a real visitor chat (created through the public widget API) is
 * reached, accepted and answered without a pointer. Checks (ch. 77): focus does not jump when the chat
 * arrives, the chat is reachable (offer shortcut / skip link for assigned routing, the Unassigned list
 * otherwise), a visible focus indicator, focus lands in the composer after accept and stays there after send.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';

const focused = (page: Page) =>
  guarded(page, 'read the focused element', () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        tag: el?.tagName ?? '',
        id: el?.id ?? '',
        role: el?.getAttribute('role') ?? '',
        href: el?.getAttribute('href') ?? '',
        name: (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim(),
        offerAccept: el?.hasAttribute('data-offer-accept') ?? false,
      };
    }),
  );
const press = (page: Page, key: string) => guarded(page, `press ${key}`, () => page.keyboard.press(key));

async function tabUntil(
  page: Page,
  match: (f: Awaited<ReturnType<typeof focused>>) => boolean,
  max = 150,
): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    await press(page, 'Tab');
    if (match(await focused(page))) return true;
  }
  return false;
}

async function hasFocusIndicator(page: Page): Promise<boolean> {
  return guarded(page, 'read the focus indicator', () =>
    page.evaluate(() => {
      const el = document.activeElement as Element;
      const s = getComputedStyle(el);
      const after = getComputedStyle(el, '::after');
      return (
        (s.outlineStyle !== 'none' && s.outlineWidth !== '0px') ||
        s.boxShadow !== 'none' ||
        (after.outlineStyle !== 'none' && after.outlineWidth !== '0px')
      );
    }),
  );
}

type Mode = 'broadcast' | 'assigned';
type Dept = { id: string; routing_mode: Mode; version: number };

// Both tests change department routing; run them one after the other.
test.describe.configure({ mode: 'serial' });

for (const mode of ['broadcast', 'assigned'] as const) {
  test(`keyboard-only (${mode} routing): reach a new chat, accept it and reply`, async ({
    page,
    request,
  }) => {
    const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Array<{
      public_key: string;
      origins: Array<{ origin: string }>;
    }>;
    const site = sites.find((s) => s.origins?.length) ?? sites[0];
    test.skip(!site, 'no site for the UI test owner');
    const origin = site.origins?.[0]?.origin ?? 'http://localhost:5173';
    // A blocked renderer (CI run 38647457598) fails the step with its main-thread stack instead of the 90 s timeout.
    await watchMainThread(page);
    await page.goto('/inbox');
    await settle(page);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'rd_csrf')?.value ?? '';
    const headers = { 'x-csrf-token': csrf };
    await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
    // Leftovers from earlier runs would hold capacity (Accept → CAPACITY_EXCEEDED) and lengthen the Tab path.
    const close = (id: string) =>
      request.post(`${API}/api/v1/chats/${id}/close`, { data: { reason: 'resolved' }, headers });
    for (const view of ['mine', 'queue']) {
      const list = (await (await request.get(`${API}/api/v1/chats?view=${view}`)).json()).data as Array<{
        id: string;
      }>;
      for (const c of list ?? []) await close(c.id);
    }
    const depts = (await (await request.get(`${API}/api/v1/departments`)).json()).data as Dept[];
    const setMode = async (d: Dept, m: Mode) => {
      const fresh = (await (await request.get(`${API}/api/v1/departments/${d.id}`)).json()).data as Dept;
      if (fresh.routing_mode !== m)
        expect(
          (
            await request.patch(`${API}/api/v1/departments/${d.id}`, {
              data: { routing_mode: m, expected_version: fresh.version },
              headers,
            })
          ).ok(),
        ).toBe(true);
    };
    for (const d of depts) await setMode(d, mode);
    try {
      await page.reload();
      await settle(page);
      await journey(page, mode, async () => {
        const sess = await (
          await request.post(`${API}/widget/v1/sessions`, {
            data: {
              site_key: site.public_key,
              host_origin: origin,
              consent: { analytics: false, policy_version: '2026-10' },
            },
          })
        ).json();
        return startVisitorChat(
          request,
          API,
          { authorization: `Bearer ${sess.data.capability}` },
          `Keyboard journey ${Date.now().toString(36)}`,
        );
      }).then(close);
    } finally {
      for (const d of depts) await setMode(d, d.routing_mode);
    }
  });
}

async function journey(page: Page, mode: Mode, createChat: () => Promise<string>): Promise<string> {
  // Park focus on the "Mine" tab, then let a chat arrive: focus must not move.
  expect(
    await tabUntil(page, (f) => f.role === 'tab' && /^Mine/.test(f.name)),
    'Mine tab reachable by Tab',
  ).toBe(true);
  const before = await focused(page);
  const chatId = await createChat();
  const offers = page.locator('#chat-offers [data-offer-accept]');
  const queueTab = page.getByRole('tab', { name: /Unassigned/ });
  if (mode === 'assigned') await expect(offers).toHaveCount(1, { timeout: 15_000 });
  else await expect(queueTab).toHaveAccessibleName(/Unassigned [1-9]/, { timeout: 15_000 });
  expect(await focused(page), 'focus does not jump when a chat arrives').toEqual(before);

  if (mode === 'assigned') {
    // The offer is announced, never focused; the skip link and Alt+Shift+O both reach it.
    await expect(
      page.locator('[aria-live="assertive"]').filter({ hasText: /Press Alt\+Shift\+O/ }),
    ).toHaveCount(1);
    await press(page, 'Shift+Tab');
    await press(page, 'Tab');
    expect(await focused(page)).toEqual(before);
    // From the top of a fresh page: "Skip to content", then "Skip to chat offers".
    await page.reload();
    await settle(page);
    await expect(offers).toHaveCount(1);
    expect(
      await tabUntil(page, (f) => /^Skip to chat offers/.test(f.name), 2),
      'skip link is the second tab stop',
    ).toBe(true);
    await press(page, 'Enter');
    expect((await focused(page)).offerAccept, 'skip link focuses the offer').toBe(true);
    await press(page, 'Shift+Tab');
    await press(page, 'Alt+Shift+O');
    expect((await focused(page)).offerAccept, 'Alt+Shift+O focuses the offer').toBe(true);
    expect(await hasFocusIndicator(page), 'offer Accept shows a focus indicator').toBe(true);
    await press(page, 'Enter');
  } else {
    // Unassigned tab → chat row → Accept chat.
    expect(
      await tabUntil(page, (f) => f.role === 'tab' && /^Unassigned/.test(f.name)),
      'Unassigned tab reachable',
    ).toBe(true);
    await press(page, 'Enter');
    expect(await tabUntil(page, (f) => f.href.includes(chatId)), 'chat row reachable by Tab').toBe(true);
    expect(await hasFocusIndicator(page), 'chat row shows a focus indicator').toBe(true);
    await press(page, 'Enter');
    await expect(page).toHaveURL(new RegExp(`/inbox/${chatId}`));
    expect(await tabUntil(page, (f) => /^Accept chat$/.test(f.name)), 'Accept chat reachable by Tab').toBe(
      true,
    );
    await press(page, 'Enter');
  }

  // Accepting moves focus into the composer of that chat; it stays there after send.
  await expect(page).toHaveURL(new RegExp(`/inbox/${chatId}`));
  await expect
    .poll(async () => (await focused(page)).id, { message: 'composer focused after accept' })
    .toBe(`composer-${chatId}`);
  const reply = `Answered with the keyboard only (${mode}).`;
  await guarded(page, 'type the reply', () => page.keyboard.type(reply));
  await press(page, 'Enter');
  await expect(page.getByText(reply).first()).toBeVisible();
  expect((await focused(page)).id, 'focus remains in the composer after send').toBe(`composer-${chatId}`);
  return chatId;
}
