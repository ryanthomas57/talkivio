import { expect, test } from '@playwright/test';
import { settle, startVisitorChat } from './routes';
import { guarded, watchMainThread } from './stall';

/**
 * Title badge (ch. 14): "(n) <title>" while chats wait, kept through client navigations. Regression for a page freeze
 * (CI run 38647457598, keyboard.spec): a client navigation briefly leaves the document without a <title> while the
 * new metadata streams in; with a chat waiting, the badge observer wrote "(1) ", which reads back as "(1)", so it
 * re-triggered itself forever in one microtask loop and the tab stopped responding. The router's swap is timing
 * dependent, so the test performs it directly (remove <title>, then insert the next one) and also switches views.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';

test('title badge: a waiting chat keeps its badge through a <title> swap without freezing the page', async ({
  page,
  request,
}) => {
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Array<{
    public_key: string;
    origins: Array<{ origin: string }>;
  }>;
  const site = sites.find((s) => s.origins?.length) ?? sites[0];
  test.skip(!site, 'no site for the UI test owner');
  await watchMainThread(page);
  await page.goto('/inbox');
  await settle(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'rd_csrf')?.value ?? '';
  const headers = { 'x-csrf-token': csrf };
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
  const close = (id: string) =>
    request.post(`${API}/api/v1/chats/${id}/close`, { data: { reason: 'resolved' }, headers });
  for (const view of ['mine', 'queue']) {
    const list = (await (await request.get(`${API}/api/v1/chats?view=${view}`)).json()).data as Array<{
      id: string;
    }>;
    for (const c of list ?? []) await close(c.id);
  }
  await expect(page).toHaveTitle(/^[^(]/);

  const sess = await (
    await request.post(`${API}/widget/v1/sessions`, {
      data: {
        site_key: site!.public_key,
        host_origin: site!.origins?.[0]?.origin ?? 'http://localhost:5173',
        consent: { analytics: false, policy_version: '2026-10' },
      },
    })
  ).json();
  const chatId = await startVisitorChat(
    request,
    API,
    { authorization: `Bearer ${sess.data.capability}` },
    `Title badge ${Date.now().toString(36)}`,
  );
  try {
    await expect(page, 'the waiting chat shows in the title').toHaveTitle(/^\(\d+\) \S/);
    const base = (await page.title()).replace(/^\(\d+\)\s*/, '');
    const titles = () =>
      guarded(page, 'read the title', () =>
        page.evaluate(() => ({ title: document.title, elements: document.querySelectorAll('title').length })),
      );

    // The router's swap: the <title> leaves the document before the next route's one is in. React's own element is
    // detached and put back with the next text, so React still finds the node it manages on later navigations.
    const title = await guarded(page, 'detach <title>', () =>
      page.evaluateHandle(() => {
        const el = document.querySelector('title')!;
        el.remove();
        return el;
      }),
    );
    expect(await titles(), 'with no <title> the badge waits instead of inventing one').toEqual({
      title: '',
      elements: 0,
    });
    await guarded(page, 'insert the next <title>', () =>
      title.evaluate((el, text) => {
        el.textContent = text;
        document.head.append(el);
      }, base),
    );
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page, 'the badge returns on the new title').toHaveTitle(
      new RegExp(`^\\(\\d+\\) ${escaped}$`),
    );
    expect((await titles()).elements).toBe(1);

    // The real navigation: switching inbox views keeps the page responsive and the badge in the title.
    for (const name of [/^Unassigned/, /^Mine/, /^Unassigned/]) {
      const tab = page.getByRole('tab', { name });
      await guarded(page, `open the ${name.source.slice(1)} view`, () => tab.click());
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveTitle(/^\(\d+\) \S/);
    }
  } finally {
    await close(chatId);
  }
});
