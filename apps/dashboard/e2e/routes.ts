/** Static dashboard routes covered by the accessibility and responsive sweeps. */
export const APP_ROUTES = [
  '/inbox',
  '/overview',
  '/visitors',
  '/history',
  '/analytics',
  '/monitor',
  '/offline-messages',
  '/team',
  '/shortcuts',
  '/settings',
  '/settings/general',
  '/settings/account',
  '/settings/departments',
  '/settings/hours',
  '/settings/sites',
  '/settings/custom-fields',
  '/settings/bans',
  '/settings/triggers',
  '/settings/triggers/new',
  '/settings/integrations',
  '/settings/privacy',
  '/settings/audit',
  '/settings/billing',
  '/design-system',
] as const;

export const PUBLIC_ROUTES = ['/login', '/signup', '/forgot-password'] as const;

/** The public website: the one-page home and the legal pages (English only, so not part of the RTL sweep). */
export const SITE_ROUTES = [
  '/',
  '/download',
  '/legal/terms',
  '/legal/privacy',
  '/legal/refund-policy',
] as const;

/** Routes opened signed out by the sweeps. */
export const ANON_ROUTES: readonly string[] = [...PUBLIC_ROUTES, ...SITE_ROUTES];

/** Wait until the page has rendered its main content (no global spinner, network quiet). */
export async function settle(page: import('@playwright/test').Page): Promise<void> {
  // Pages poll and hold sockets open, so network idle is capped: main content + no busy region is the signal.
  await page
    .locator('main, form')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await page
    .locator('[aria-busy="true"]')
    .first()
    .waitFor({ state: 'detached', timeout: 5_000 })
    .catch(() => undefined);
}

/**
 * Opens a visitor chat over the widget API. Admission needs an online agent with a live socket, and the dashboard's
 * socket connects shortly after the page renders, so DEPARTMENT_UNAVAILABLE (no_agents) is retried until it is up.
 */
export async function startVisitorChat(
  request: import('@playwright/test').APIRequestContext,
  api: string,
  headers: Record<string, string>,
  message: string,
): Promise<string> {
  const { expect } = await import('@playwright/test');
  let last: unknown;
  await expect
    .poll(
      async () => {
        last = await (
          await request.post(`${api}/widget/v1/chats`, {
            headers,
            data: { client_request_id: crypto.randomUUID(), message },
          })
        ).json();
        const body = last as { data?: { chat?: { id?: string } }; error?: { code?: string } };
        return body.data?.chat?.id ? 'admitted' : (body.error?.code ?? 'unknown');
      },
      {
        message: 'the visitor chat is admitted once the agent socket is live',
        timeout: 15_000,
        intervals: [250, 500, 1_000],
      },
    )
    .toBe('admitted');
  return (last as { data: { chat: { id: string } } }).data.chat.id;
}
