import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from '@playwright/test';
import { settle, startVisitorChat } from './routes';

/**
 * Realtime delivery faults injected into the dashboard's real Socket.IO connection (proxied with routeWebSocket):
 *  - WS02: `message.created` frames for one chat are held, then delivered newest first, duplicated (same event id,
 *    and a copy under a new event id that only the reducer can recognise) and with one frame dropped. The
 *    conversation must show every message exactly once, in seq order, the dropped one recovered by the REST
 *    catch-up (`after_seq`) that the gap triggers.
 *  - WS01: the acknowledgement of an agent's `message.send` is dropped after the server committed the message.
 *    With the live frame still arriving the bubble settles once and never fails; with the frame lost too, the
 *    bubble fails honestly and Retry re-sends the same client_message_id, whose acknowledgement carries the
 *    original message (same server id) — one stored row, one bubble.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
type Frame = {
  event_id: string;
  type: string;
  payload: { message?: { id?: string; chat_id?: string; body?: string; seq?: number } };
};

/** Socket.IO packets on the agent namespace: `42/agent,<ack id?>[…]` (event) or `43/agent,<ack id>[…]` (ack). */
function packet(raw: string | Buffer): { kind: 'event' | 'ack'; ackId: string; data: unknown[] } | null {
  if (typeof raw !== 'string') return null;
  const m = /^4([23])\/agent,(\d*)(\[.*)$/s.exec(raw);
  if (!m) return null;
  try {
    return { kind: m[1] === '2' ? 'event' : 'ack', ackId: m[2]!, data: JSON.parse(m[3]!) as unknown[] };
  } catch {
    return null;
  }
}
const frameOf = (raw: string | Buffer): Frame | null => {
  const p = packet(raw);
  return p?.kind === 'event' && p.data[0] === 'event' ? (p.data[1] as Frame) : null;
};
const repack = (frame: Frame) => `42/agent,${JSON.stringify(['event', frame])}`;

type Hooks = {
  fromServer?: (raw: string | Buffer) => boolean;
  fromClient?: (raw: string | Buffer) => boolean;
};

/** Proxies the socket (a hook returning false swallows the packet), connects the agent, then opens a visitor chat. */
async function openChat(page: Page, request: APIRequestContext, hooks: Hooks) {
  const sites = (await (await request.get(`${API}/api/v1/sites`)).json()).data as Array<{
    public_key: string;
    origins: Array<{ origin: string }>;
  }>;
  const site = sites.find((s) => s.origins?.length) ?? sites[0];
  test.skip(!site, 'no site for the UI test owner');
  const csrf = (await request.storageState()).cookies.find((c) => c.name === 'rd_csrf')?.value ?? '';
  const headers = { 'x-csrf-token': csrf };
  await request.put(`${API}/api/v1/agents/me/presence`, { data: { status: 'online' }, headers });
  for (const view of ['mine', 'queue']) {
    const list = (await (await request.get(`${API}/api/v1/chats?view=${view}`)).json()).data as Array<{
      id: string;
    }>;
    for (const c of list ?? [])
      await request.post(`${API}/api/v1/chats/${c.id}/close`, { data: { reason: 'resolved' }, headers });
  }
  const route: { client: WebSocketRoute | null } = { client: null };
  await page.routeWebSocket(/\/realtime\/v1\//, (ws) => {
    route.client = ws;
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (hooks.fromClient?.(m) !== false) server.send(m);
    });
    server.onMessage((m) => {
      if (hooks.fromServer?.(m) !== false) ws.send(m);
    });
  });
  // The agent must be connected (through the proxy) before a visitor can be admitted.
  await page.goto('/inbox');
  await settle(page);
  const sess = (
    await (
      await request.post(`${API}/widget/v1/sessions`, {
        data: {
          site_key: site!.public_key,
          host_origin: site!.origins?.[0]?.origin ?? 'http://localhost:5173',
          consent: { analytics: false, policy_version: '2026-10' },
        },
      })
    ).json()
  ).data;
  const visitor = { authorization: `Bearer ${sess.capability}` };
  const chatId = await startVisitorChat(request, API, visitor, `Realtime check ${Date.now().toString(36)}`);
  expect((await request.post(`${API}/api/v1/chats/${chatId}/accept`, { data: {}, headers })).ok()).toBe(true);
  await page.goto(`/inbox/${chatId}`);
  await settle(page);
  await expect(page.getByRole('log').getByText(/^Realtime check/)).toBeVisible();
  return {
    chatId,
    visitor,
    route,
    stored: async (body: string) =>
      (
        (await (await request.get(`${API}/api/v1/chats/${chatId}/messages?limit=100`)).json()).data
          .items as Array<{ id: string; body: string | null }>
      ).filter((m) => m.body === body),
    close: () =>
      request.post(`${API}/api/v1/chats/${chatId}/close`, { data: { reason: 'resolved' }, headers }),
  };
}

test('WS02 inbox: duplicate, reversed and dropped socket frames show each message once, in order (gap filled over REST)', async ({
  page,
  request,
}) => {
  let chatId = '';
  let holding = false;
  // First frame per message id (a message can reach the agent on more than one scope; extra copies pass through).
  const held = new Map<string, Frame>();
  const chat = await openChat(page, request, {
    fromServer: (m) => {
      const f = frameOf(m);
      const id =
        f?.type === 'message.created' && f.payload.message?.chat_id === chatId
          ? f.payload.message.id
          : undefined;
      if (holding && id && !held.has(id)) {
        held.set(id, f!);
        return false;
      }
      return true;
    },
  });
  chatId = chat.chatId;
  try {
    holding = true;
    // Base 36: a 13-digit timestamp in a public message can be Luhn-valid and get masked as a card number.
    const stamp = Date.now().toString(36);
    const texts = [1, 2, 3, 4].map((n) => `WS02 m${n} ${stamp}`);
    for (const body of texts)
      expect(
        (
          await request.post(`${API}/widget/v1/chats/${chatId}/messages`, {
            headers: chat.visitor,
            data: { client_message_id: crypto.randomUUID(), body },
          })
        ).ok(),
      ).toBe(true);
    await expect.poll(() => held.size, { message: 'frames for all four messages intercepted' }).toBe(4);
    holding = false;
    const frames = [...held.values()].sort(
      (a, b) => (a.payload.message!.seq ?? 0) - (b.payload.message!.seq ?? 0),
    );
    expect(frames.map((f) => f.payload.message!.body)).toEqual(texts);
    await expect(page.getByRole('log').getByText(texts[0]!)).toHaveCount(0);

    const catchUp = page.waitForRequest(
      (r) => r.url().includes(`/chats/${chatId}/messages`) && /[?&]after_seq=/.test(r.url()),
    );
    const [m1, m2, , m4] = frames;
    // Newest first, the same frame twice, a copy under a new event id, then the oldest; m3's frame never arrives.
    for (const frame of [m4!, m4!, m2!, { ...m2!, event_id: crypto.randomUUID() }, m1!])
      chat.route.client!.send(repack(frame));
    await catchUp;

    const log = page.getByRole('log');
    await expect(log.getByText(texts[2]!), 'the dropped message is recovered over REST').toHaveCount(1);
    for (const text of texts)
      await expect(log.getByText(text), `"${text}" shown exactly once`).toHaveCount(1);
    const order = await log.getByText(new RegExp(`^WS02 m[1-4] ${stamp}$`)).allTextContents();
    expect(order, 'rendered in seq order').toEqual(texts);
  } finally {
    await chat.close();
  }
});

for (const frameLost of [false, true]) {
  test(`WS01 inbox: the ack of a committed send is lost${frameLost ? ' with its frame: Failed, and Retry returns the original message' : ': the live frame settles the bubble once'}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const text = `WS01 ${frameLost ? 'retry' : 'frame'} ${Date.now().toString(36)}`;
    let dropAcks = true;
    const sends: Array<{ ackId: string; clientMessageId: string }> = [];
    const ackResults = new Map<string, { id?: string }>();
    const chat = await openChat(page, request, {
      fromClient: (m) => {
        const p = packet(m);
        const cmd =
          p?.kind === 'event' && p.data[0] === 'command'
            ? (p.data[1] as { type?: string; payload?: { body?: string; client_message_id?: string } })
            : null;
        if (cmd?.type === 'message.send' && cmd.payload?.body === text)
          sends.push({ ackId: p!.ackId, clientMessageId: cmd.payload.client_message_id ?? '' });
        return true;
      },
      fromServer: (m) => {
        const p = packet(m);
        const send = p?.kind === 'ack' ? sends.find((s) => s.ackId === p.ackId) : undefined;
        if (send) {
          ackResults.set(send.ackId, (p!.data[0] as { result?: { id?: string } })?.result ?? {});
          return !(dropAcks && send === sends[0]); // committed, but the client never hears it
        }
        const f = frameOf(m);
        return !(frameLost && f?.type === 'message.created' && f.payload.message?.body === text);
      },
    });
    try {
      const composer = page.locator(`#composer-${chat.chatId}`);
      await composer.fill(text);
      await composer.press('Enter');
      await expect
        .poll(() => chat.stored(text).then((r) => r.length), { message: 'the server committed the message' })
        .toBe(1);
      const [row] = await chat.stored(text);
      await expect
        .poll(() => ackResults.get(sends[0]?.ackId ?? '')?.id, {
          message: 'the server acknowledged (and the proxy dropped it)',
        })
        .toBe(row!.id);
      const log = page.getByRole('log');
      if (!frameLost) {
        await expect(log.getByText(text), 'settled from the live frame').toHaveCount(1);
        await page.waitForTimeout(11_000); // past the 10 s acknowledgement timeout
        await expect(
          page.getByRole('alert').filter({ hasText: 'Failed' }),
          'a send confirmed by its frame never turns into a failure',
        ).toHaveCount(0);
        await expect(log.getByText(text)).toHaveCount(1);
        expect(sends, 'no automatic resend').toHaveLength(1);
      } else {
        const failed = page
          .getByRole('alert')
          .filter({ hasText: 'Failed: No acknowledgement from the server' });
        await expect(failed, 'no acknowledgement and no frame: the bubble fails honestly').toBeVisible({
          timeout: 20_000,
        });
        dropAcks = false;
        await failed.getByRole('button', { name: 'Retry' }).click();
        await expect(failed).toHaveCount(0);
        await expect(log.getByText(text), 'one bubble after the retry').toHaveCount(1);
        expect(sends, 'the retry went out once').toHaveLength(2);
        expect(sends[1]!.clientMessageId, 'Retry re-sends the same client_message_id').toBe(
          sends[0]!.clientMessageId,
        );
        await expect
          .poll(() => ackResults.get(sends[1]!.ackId)?.id, {
            message: "the retry's acknowledgement carries the original message id",
          })
          .toBe(row!.id);
        expect(
          (await chat.stored(text)).map((m) => m.id),
          'still one stored row — the original',
        ).toEqual([row!.id]);
      }
    } finally {
      await chat.close();
    }
  });
}
