import { randomBytes } from 'node:crypto';
import {
  GatewayError,
  type CardDetails,
  type CardSession,
  type ChargeInput,
  type ChargeResult,
  type PaymentGateway,
} from './gateway';

/**
 * Test gateway (BILLING_PROVIDER=fake; refused in production). The dashboard's test card form turns a test card
 * number into a token `fake_<last four>_<random>` in the browser, as the real hosted form would, so the number never
 * reaches the server. Behaviour follows the last four digits:
 *   4242 (and any other) approved · 0341 saved, then every charge declined · 0002 refused when saved
 *   0119 the gateway cannot be reached when charging · 0259 the charge outcome is unknown (timeout)
 */
export const FAKE_TOKEN_RE = /^fake_(\d{4})_[a-z0-9]{8,32}$/;

export class FakeGateway implements PaymentGateway {
  readonly name = 'fake' as const;

  async cardSession(): Promise<CardSession> {
    return { provider: 'fake', token: `fake_session_${randomBytes(8).toString('hex')}`, scriptUrl: null };
  }

  async verifyCard(token: string): Promise<CardDetails> {
    const last4 = FAKE_TOKEN_RE.exec(token)?.[1];
    if (!last4) throw new GatewayError('That card could not be saved. Enter it again.', true);
    if (last4 === '0002') throw new GatewayError('The card was declined.', true);
    return { token, brand: 'Visa', last4, exp: '1230' };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const last4 = FAKE_TOKEN_RE.exec(input.token)?.[1];
    if (!last4) return { outcome: 'declined', txnId: null, message: 'INVALID TOKEN' };
    if (last4 === '0341')
      return {
        outcome: 'declined',
        txnId: `fake_txn_${randomBytes(6).toString('hex')}`,
        message: 'DECLINED',
      };
    if (last4 === '0119')
      return { outcome: 'unavailable', message: 'Payment gateway unreachable (ECONNREFUSED)' };
    if (last4 === '0259') return { outcome: 'unknown', message: 'The operation was aborted due to timeout' };
    return { outcome: 'approved', txnId: `fake_txn_${randomBytes(6).toString('hex')}`, message: 'APPROVAL' };
  }
}
