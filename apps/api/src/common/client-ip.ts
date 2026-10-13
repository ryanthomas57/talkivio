import type { IncomingHttpHeaders } from 'node:http';
import proxyaddr from 'proxy-addr';
import { env } from '../config/env';

type TrustFn = (addr: string, index: number) => boolean;
let compiled: { value: string; fn: TrustFn } | null = null;

/** Same `TRUST_PROXY` semantics as Express' `trust proxy` setting (boolean, hop count, or address list). */
function trust(): TrustFn {
  const value = env().TRUST_PROXY;
  if (compiled?.value === value) return compiled.fn;
  let fn: TrustFn;
  if (value === 'true') fn = () => true;
  else if (value === 'false') fn = () => false;
  else if (/^\d+$/.test(value)) {
    const hops = Number(value);
    fn = (_addr, i) => i < hops;
  } else fn = proxyaddr.compile(value.split(',').map((s) => s.trim()).filter(Boolean));
  compiled = { value, fn };
  return fn;
}

/**
 * Client address for a WebSocket handshake. Socket.IO exposes only the TCP peer;
 * behind the reverse proxy that is the proxy itself, so per-client rate limits and
 * IP bans would otherwise apply to every visitor at once.
 */
export function socketClientIp(handshake: { address: string; headers: IncomingHttpHeaders }): string {
  return proxyaddr({ headers: handshake.headers, connection: { remoteAddress: handshake.address } }, trust());
}
