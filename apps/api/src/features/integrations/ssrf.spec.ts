import { describe, expect, it } from 'vitest';
import { loadIntegrationsConfig } from './config';
import { classifyAddress, expandV6, resolveWebhookTarget, SsrfError, type Resolver } from './ssrf';

const off = loadIntegrationsConfig({ NODE_ENV: 'development' });
const on = loadIntegrationsConfig({
  NODE_ENV: 'development',
  TALKIVIO_WEBHOOK_ALLOW_PRIVATE: 'true',
  TALKIVIO_WEBHOOK_ALLOW_PRIVATE_HOSTS: '127.0.0.1:4196',
});
const prod = loadIntegrationsConfig({ NODE_ENV: 'production', TALKIVIO_WEBHOOK_ALLOW_PRIVATE: 'true' });
const fixed =
  (addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof SsrfError ? err.code : 'other';
  }
}

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.20.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['169.254.169.254', 'metadata'],
    ['169.254.1.1', 'link_local'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:7f00:1', 'loopback'],
    ['fd00:ec2::254', 'metadata'],
    ['fc00::1', 'private'],
    ['fe80::1%lo0', 'link_local'],
    ['64:ff9b::a00:1', 'reserved'],
    ['2001:db8::1', 'reserved'],
    ['2606:4700:4700::1111', 'public'],
  ])('%s → %s', (ip, cls) => expect(classifyAddress(ip)).toBe(cls));

  it('expands IPv6 forms', () => {
    expect(expandV6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandV6('1:2::7:8')).toEqual([1, 2, 0, 0, 0, 0, 7, 8]);
    expect(expandV6('1:2:3')).toBeNull();
  });
});

describe('resolveWebhookTarget', () => {
  it('rejects non-http schemes, credentials and fragments', async () => {
    expect(await code(resolveWebhookTarget('ftp://example.com/x', off, fixed(['93.184.216.34'])))).toBe(
      'scheme_not_allowed',
    );
    expect(await code(resolveWebhookTarget('file:///etc/passwd', off, fixed([])))).toBe('scheme_not_allowed');
    expect(await code(resolveWebhookTarget('https://u:p@example.com/', off, fixed(['93.184.216.34'])))).toBe(
      'credentials_in_url',
    );
    expect(await code(resolveWebhookTarget('https://example.com/#x', off, fixed(['93.184.216.34'])))).toBe(
      'invalid_url',
    );
  });

  it('requires https in production', async () => {
    expect(await code(resolveWebhookTarget('http://example.com/', prod, fixed(['93.184.216.34'])))).toBe(
      'https_required',
    );
    expect(await code(resolveWebhookTarget('https://example.com/', prod, fixed(['93.184.216.34'])))).toBe(
      'ok',
    );
  });

  it('blocks loopback, private and metadata literals when the flag is off', async () => {
    for (const url of [
      'http://127.0.0.1:4196/h',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://0.0.0.0/',
    ]) {
      expect(await code(resolveWebhookTarget(url, off))).toBe('blocked_address');
    }
  });

  it('blocks a public name that resolves to a private address (and any mixed answer)', async () => {
    expect(await code(resolveWebhookTarget('https://rebind.example/', off, fixed(['127.0.0.1'])))).toBe(
      'blocked_address',
    );
    expect(
      await code(resolveWebhookTarget('https://mixed.example/', off, fixed(['93.184.216.34', '10.0.0.1']))),
    ).toBe('blocked_address');
    expect(await code(resolveWebhookTarget('https://meta.example/', off, fixed(['169.254.169.254'])))).toBe(
      'blocked_address',
    );
  });

  it('pins the first validated address', async () => {
    const t = await resolveWebhookTarget(
      'https://ok.example/hook',
      off,
      fixed(['93.184.216.34', '93.184.216.35']),
    );
    expect(t.address).toBe('93.184.216.34');
    expect(t.viaTestException).toBe(false);
  });

  it('test exception only admits allowlisted loopback/private host:port, never metadata', async () => {
    expect(await code(resolveWebhookTarget('http://127.0.0.1:4196/hooks', on))).toBe('ok');
    expect(await code(resolveWebhookTarget('http://127.0.0.1:4197/hooks', on))).toBe('blocked_address');
    expect(await code(resolveWebhookTarget('http://169.254.169.254/', on))).toBe('blocked_address');
    expect(await code(resolveWebhookTarget('http://10.0.0.5:4196/', on))).toBe('blocked_address');
  });

  it('refuses the test exception in production', () => {
    expect(prod.allowPrivate).toBe(false);
    expect(prod.allowPrivateRefused).toBe(true);
    expect(prod.retryScheduleMs).toEqual([
      0, 10_000, 60_000, 300_000, 1_800_000, 7_200_000, 28_800_000, 86_400_000,
    ]);
    expect(
      loadIntegrationsConfig({ NODE_ENV: 'production', TALKIVIO_WEBHOOK_RETRY_SCHEDULE_MS: '0,1,1' })
        .retryScheduleMs,
    ).toHaveLength(8);
  });

  it('reports DNS failures', async () => {
    const failing: Resolver = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await code(resolveWebhookTarget('https://nope.invalid/', off, failing))).toBe('dns_failed');
  });
});
