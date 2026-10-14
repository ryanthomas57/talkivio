import { afterEach, describe, expect, it, vi } from 'vitest';
import { productionRefusals } from '../../config/env';
import { ConvergeGateway, convergeTxn, parseConvergeXml } from './converge.gateway';
import { FakeGateway } from './fake.gateway';

const config = {
  CONVERGE_ENV: 'demo' as const,
  CONVERGE_MERCHANT_ID: 'm1',
  CONVERGE_USER_ID: 'u1',
  CONVERGE_PIN: 'p&1',
  CONVERGE_TOKEN_URL: undefined,
  CONVERGE_XML_URL: undefined,
  CONVERGE_LIGHTBOX_URL: undefined,
};

function mockFetch(...bodies: Array<string | Error>) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: URLSearchParams }) => {
      calls.push({ url, body: init.body });
      const next = bodies.shift();
      if (next instanceof Error) throw next;
      return new Response(next ?? '', { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('Converge XML', () => {
  it('escapes values and reads a flat <txn> answer', () => {
    expect(convergeTxn({ ssl_pin: 'a<b&c' })).toBe('<txn><ssl_pin>a&lt;b&amp;c</ssl_pin></txn>');
    expect(
      parseConvergeXml(
        '<txn><ssl_result>0</ssl_result><ssl_result_message>APPROVAL</ssl_result_message><x>a &amp; b</x></txn>',
      ),
    ).toEqual({
      ssl_result: '0',
      ssl_result_message: 'APPROVAL',
      x: 'a & b',
    });
  });
});

describe('ConvergeGateway', () => {
  it('asks for a Lightbox session server to server and returns the demo script', async () => {
    const calls = mockFetch('SESSIONTOKEN123');
    const s = await new ConvergeGateway(config).cardSession();
    expect(s).toEqual({
      provider: 'converge',
      token: 'SESSIONTOKEN123',
      scriptUrl: 'https://api.demo.convergepay.com/hosted-payments/PayWithConverge.js',
    });
    expect(calls[0]!.url).toBe('https://api.demo.convergepay.com/hosted-payments/transaction_token');
    expect(Object.fromEntries(calls[0]!.body)).toMatchObject({
      ssl_merchant_id: 'm1',
      ssl_user_id: 'u1',
      ssl_pin: 'p&1',
      ssl_transaction_type: 'ccgettoken',
      ssl_add_token: 'Y',
    });
  });

  it('refuses an error page in place of a session token', async () => {
    mockFetch('<html>Error</html>');
    await expect(new ConvergeGateway(config).cardSession()).rejects.toThrow(/could not be opened/);
  });

  it('verifies a card token with ccquerytoken and takes the card details from Converge', async () => {
    const calls = mockFetch(
      '<txn><ssl_token>4421912014039990</ssl_token><ssl_card_number>41**********9990</ssl_card_number><ssl_exp_date>1228</ssl_exp_date><ssl_card_short_description>VISA</ssl_card_short_description></txn>',
    );
    const c = await new ConvergeGateway(config).verifyCard('4421912014039990');
    expect(c).toEqual({ token: '4421912014039990', brand: 'Visa', last4: '9990', exp: '1228' });
    const xml = calls[0]!.body.get('xmldata')!;
    expect(xml).toContain('<ssl_transaction_type>ccquerytoken</ssl_transaction_type>');
    expect(xml).toContain('<ssl_token>4421912014039990</ssl_token>');
    expect(calls[0]!.url).toBe('https://api.demo.convergepay.com/VirtualMerchantDemo/processxml.do');
  });

  it('refuses tokens Converge does not know, and malformed ones without asking', async () => {
    mockFetch(
      '<txn><errorCode>5089</errorCode><errorName>Invalid Token</errorName><errorMessage>The token supplied was not found.</errorMessage></txn>',
    );
    await expect(new ConvergeGateway(config).verifyCard('4421912014039990')).rejects.toThrow(/not found/);
    await expect(new ConvergeGateway(config).verifyCard('bad token <x>')).rejects.toThrow(
      /could not be saved/,
    );
  });

  it('charges a stored card as a recurring sale and maps approvals and declines', async () => {
    const calls = mockFetch(
      '<txn><ssl_result>0</ssl_result><ssl_result_message>APPROVAL</ssl_result_message><ssl_txn_id>TXN-1</ssl_txn_id></txn>',
      '<txn><ssl_result>1</ssl_result><ssl_result_message>DECLINED</ssl_result_message><ssl_txn_id>TXN-2</ssl_txn_id></txn>',
    );
    const g = new ConvergeGateway(config);
    expect(
      await g.charge({
        token: 'tok',
        amountCents: 2900,
        invoiceNumber: 'TK261014000000ABCDEF12',
        description: 'Team',
      }),
    ).toEqual({ outcome: 'approved', txnId: 'TXN-1', message: 'APPROVAL' });
    const xml = calls[0]!.body.get('xmldata')!;
    expect(xml).toContain('<ssl_transaction_type>ccsale</ssl_transaction_type>');
    expect(xml).toContain('<ssl_amount>29.00</ssl_amount>');
    expect(xml).toContain('<ssl_recurring_flag>1</ssl_recurring_flag>');
    expect(
      await g.charge({ token: 'tok', amountCents: 2900, invoiceNumber: 'X', description: 'Team' }),
    ).toEqual({ outcome: 'declined', txnId: 'TXN-2', message: 'DECLINED' });
  });

  it('tells a request that never left (safe to retry) from one whose outcome is unknown', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    mockFetch(refused, timeout);
    const g = new ConvergeGateway(config);
    expect(
      (await g.charge({ token: 't', amountCents: 100, invoiceNumber: 'X', description: 'd' })).outcome,
    ).toBe('unavailable');
    expect(
      (await g.charge({ token: 't', amountCents: 100, invoiceNumber: 'X', description: 'd' })).outcome,
    ).toBe('unknown');
  });

  it('uses the production hosts for CONVERGE_ENV=production and needs all three credentials', () => {
    expect(() => new ConvergeGateway({ ...config, CONVERGE_PIN: undefined })).toThrow(/CONVERGE_PIN/);
  });
});

describe('billing configuration', () => {
  it('refuses the test gateway and an incomplete Converge setup in production', () => {
    const base = {
      NODE_ENV: 'production' as const,
      EMAIL_PROVIDER: 'smtp' as const,
      SCAN_MODE: 'clamav' as const,
    };
    expect(productionRefusals({ ...base, BILLING_PROVIDER: 'fake' })).toEqual([
      expect.stringMatching(/BILLING_PROVIDER=fake is refused/),
    ]);
    expect(productionRefusals({ ...base, BILLING_PROVIDER: 'converge', CONVERGE_MERCHANT_ID: 'm' })).toEqual([
      expect.stringMatching(/needs CONVERGE_MERCHANT_ID/),
    ]);
    expect(
      productionRefusals({
        ...base,
        BILLING_PROVIDER: 'converge',
        CONVERGE_MERCHANT_ID: 'm',
        CONVERGE_USER_ID: 'u',
        CONVERGE_PIN: 'p',
      }),
    ).toEqual([]);
  });

  it('the test gateway follows the card number’s last four digits', async () => {
    const g = new FakeGateway();
    await expect(g.verifyCard('fake_0002_abcdefgh')).rejects.toThrow(/declined/);
    expect((await g.verifyCard('fake_4242_abcdefgh')).last4).toBe('4242');
    expect(
      (await g.charge({ token: 'fake_0341_abcdefgh', amountCents: 1, invoiceNumber: 'X', description: 'd' }))
        .outcome,
    ).toBe('declined');
    expect(
      (await g.charge({ token: 'fake_4242_abcdefgh', amountCents: 1, invoiceNumber: 'X', description: 'd' }))
        .outcome,
    ).toBe('approved');
  });
});
