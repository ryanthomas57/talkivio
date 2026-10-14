import { Logger } from '@nestjs/common';
import type { Env } from '../../config/env';
import {
  amountString,
  GatewayError,
  type CardDetails,
  type CardSession,
  type ChargeInput,
  type ChargeResult,
  type PaymentGateway,
} from './gateway';

/**
 * Converge (Elavon) adapter.
 *
 *  - cardSession: server-to-server request for a Lightbox session token (`ccgettoken`, card stored in Card Manager),
 *    returned to the browser with the PayWithConverge.js URL. The customer types the card into Converge's form.
 *  - verifyCard: `ccquerytoken` on the token the browser got back. Tokens belong to one merchant account, so a token
 *    that resolves here is a real stored card of ours; the card details shown come from this answer, not the browser.
 *  - charge: `ccsale` against the stored token, marked as a recurring (merchant-initiated, card-on-file) payment.
 *
 * Field names follow the Converge developer guide; confirm them against a Converge demo account before going live
 * (docs/operations/billing.md lists the checks).
 */
const HOSTS = {
  demo: {
    token: 'https://api.demo.convergepay.com/hosted-payments/transaction_token',
    xml: 'https://api.demo.convergepay.com/VirtualMerchantDemo/processxml.do',
    lightbox: 'https://api.demo.convergepay.com/hosted-payments/PayWithConverge.js',
  },
  production: {
    token: 'https://api.convergepay.com/hosted-payments/transaction_token',
    xml: 'https://api.convergepay.com/VirtualMerchant/processxml.do',
    lightbox: 'https://api.convergepay.com/hosted-payments/PayWithConverge.js',
  },
} as const;

const TIMEOUT_MS = 30_000;

/** Errors raised before any byte reached Converge: the request was not sent, so retrying is safe. */
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const xmlEscape = (v: string) =>
  v.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );
const xmlUnescape = (v: string) =>
  v.replace(
    /&(lt|gt|amp|apos|quot);/g,
    (_, e: string) => ({ lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' })[e]!,
  );

/** Converge answers with one flat <txn> element; read its children into a map. */
export function parseConvergeXml(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Children of <txn> (the wrapper itself would otherwise match as one element and hide them).
  const inner = /<txn>([\s\S]*)<\/txn>/.exec(body)?.[1] ?? body;
  for (const m of inner.matchAll(/<([A-Za-z_][\w]*)>([\s\S]*?)<\/\1>/g))
    out[m[1]!] = xmlUnescape(m[2]!.trim());
  return out;
}

export function convergeTxn(fields: Record<string, string>): string {
  return `<txn>${Object.entries(fields)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join('')}</txn>`;
}

/** Card brand from Converge's card type / short description fields. */
function brandOf(r: Record<string, string>): string | null {
  const v = r.ssl_card_short_description || r.ssl_card_type || '';
  const map: Record<string, string> = {
    VISA: 'Visa',
    MC: 'Mastercard',
    AMEX: 'American Express',
    DISC: 'Discover',
    JCB: 'JCB',
    DINERS: 'Diners Club',
  };
  return map[v.toUpperCase()] ?? (v ? v.slice(0, 40) : null);
}

export class ConvergeGateway implements PaymentGateway {
  readonly name = 'converge' as const;
  private readonly logger = new Logger('Converge');
  private readonly urls: { token: string; xml: string; lightbox: string };
  private readonly creds: { ssl_merchant_id: string; ssl_user_id: string; ssl_pin: string };

  constructor(
    e: Pick<
      Env,
      | 'CONVERGE_ENV'
      | 'CONVERGE_MERCHANT_ID'
      | 'CONVERGE_USER_ID'
      | 'CONVERGE_PIN'
      | 'CONVERGE_TOKEN_URL'
      | 'CONVERGE_XML_URL'
      | 'CONVERGE_LIGHTBOX_URL'
    >,
  ) {
    const base = HOSTS[e.CONVERGE_ENV];
    this.urls = {
      token: e.CONVERGE_TOKEN_URL ?? base.token,
      xml: e.CONVERGE_XML_URL ?? base.xml,
      lightbox: e.CONVERGE_LIGHTBOX_URL ?? base.lightbox,
    };
    if (!e.CONVERGE_MERCHANT_ID || !e.CONVERGE_USER_ID || !e.CONVERGE_PIN)
      throw new Error(
        'BILLING_PROVIDER=converge needs CONVERGE_MERCHANT_ID, CONVERGE_USER_ID and CONVERGE_PIN',
      );
    this.creds = {
      ssl_merchant_id: e.CONVERGE_MERCHANT_ID,
      ssl_user_id: e.CONVERGE_USER_ID,
      ssl_pin: e.CONVERGE_PIN,
    };
  }

  async cardSession(): Promise<CardSession> {
    const res = await this.post(
      this.urls.token,
      new URLSearchParams({
        ...this.creds,
        ssl_transaction_type: 'ccgettoken',
        ssl_add_token: 'Y',
        ssl_verify: 'Y',
      }),
    );
    const token = res.trim();
    // A valid session token is a single opaque string; anything else is an error page or message.
    if (!token || /[\s<]/.test(token) || token.length > 2000) {
      this.logger.warn(`Lightbox session token refused: ${token.slice(0, 120)}`);
      throw new GatewayError('The payment form could not be opened. Try again in a moment.');
    }
    return { provider: 'converge', token, scriptUrl: this.urls.lightbox };
  }

  async verifyCard(token: string): Promise<CardDetails> {
    if (!/^[\w-]{4,100}$/.test(token))
      throw new GatewayError('That card could not be saved. Enter it again.', true);
    const r = await this.xml({ ssl_transaction_type: 'ccquerytoken', ssl_token: token });
    if (r.errorCode)
      throw new GatewayError(r.errorMessage || 'That card could not be saved. Enter it again.', true);
    if (r.ssl_token && r.ssl_token !== token)
      throw new GatewayError('That card could not be saved. Enter it again.', true);
    const digits = (r.ssl_card_number ?? '').replace(/\D/g, '');
    return {
      token,
      brand: brandOf(r),
      last4: digits.length >= 4 ? digits.slice(-4) : null,
      exp: /^\d{4}$/.test(r.ssl_exp_date ?? '') ? r.ssl_exp_date! : null,
    };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    let r: Record<string, string>;
    try {
      r = await this.xml({
        ssl_transaction_type: 'ccsale',
        ssl_token: input.token,
        ssl_amount: amountString(input.amountCents),
        ssl_invoice_number: input.invoiceNumber.slice(0, 25),
        ssl_description: input.description.slice(0, 255),
        ssl_recurring_flag: '1',
      });
    } catch (err) {
      const code =
        (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code ?? '';
      if (NOT_SENT.has(code))
        return { outcome: 'unavailable', message: `Payment gateway unreachable (${code})` };
      return { outcome: 'unknown', message: (err as Error).message.slice(0, 300) };
    }
    if (r.errorCode)
      return {
        outcome: 'declined',
        txnId: null,
        message: `${r.errorName ?? 'Error'}: ${r.errorMessage ?? r.errorCode}`.slice(0, 300),
      };
    const message = r.ssl_result_message || 'No result message';
    return r.ssl_result === '0'
      ? { outcome: 'approved', txnId: r.ssl_txn_id ?? null, message }
      : { outcome: 'declined', txnId: r.ssl_txn_id ?? null, message };
  }

  private async xml(fields: Record<string, string>): Promise<Record<string, string>> {
    const body = await this.post(
      this.urls.xml,
      new URLSearchParams({ xmldata: convergeTxn({ ...this.creds, ...fields }) }),
    );
    return parseConvergeXml(body);
  }

  private async post(url: string, form: URLSearchParams): Promise<string> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/plain, application/xml' },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new GatewayError(`Converge answered HTTP ${res.status}`);
    return text;
  }
}
