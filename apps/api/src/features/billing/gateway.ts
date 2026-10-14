/**
 * The payment gateway behind subscriptions. Cards are entered in the gateway's own hosted form (Converge Lightbox),
 * which hands the browser a token for the stored card; the server only ever handles that token. Every token from the
 * browser is checked with the gateway (verifyCard) before it is kept, so a forged or foreign token is refused.
 */
export interface CardSession {
  provider: 'converge' | 'fake';
  /** One-time session token the hosted form needs. */
  token: string;
  /** Script that opens the hosted form (Converge's PayWithConverge.js); absent for the fake gateway. */
  scriptUrl: string | null;
}

export interface CardDetails {
  /** The gateway's reusable reference to the stored card. */
  token: string;
  brand: string | null;
  last4: string | null;
  /** MMYY. */
  exp: string | null;
}

export interface ChargeInput {
  token: string;
  amountCents: number;
  invoiceNumber: string;
  description: string;
}

export type ChargeResult =
  | { outcome: 'approved'; txnId: string | null; message: string }
  | { outcome: 'declined'; txnId: string | null; message: string }
  /** Never reached the gateway (could not connect): nothing was charged, so it is safe to try again later. */
  | { outcome: 'unavailable'; message: string }
  /** The request may or may not have reached the gateway (timeout, connection reset): never retry blindly. */
  | { outcome: 'unknown'; message: string };

export interface PaymentGateway {
  readonly name: 'converge' | 'fake';
  cardSession(input: { tenantId: string; email: string }): Promise<CardSession>;
  /** Confirms a token from the browser is a live card on this merchant account and returns what it shows. */
  verifyCard(token: string): Promise<CardDetails>;
  charge(input: ChargeInput): Promise<ChargeResult>;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    /** Safe to show the customer (a decline reason), as opposed to a configuration or transport failure. */
    readonly customerFacing = false,
  ) {
    super(message);
  }
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** "12.50" from cents, the amount format Converge expects. */
export const amountString = (cents: number) => (cents / 100).toFixed(2);
