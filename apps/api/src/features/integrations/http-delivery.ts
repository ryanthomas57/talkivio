/**
 * Single outbound webhook POST with SSRF-safe transport properties:
 * connection pinned to the pre-validated address (no second DNS lookup), no
 * redirects, hard timeout, response body read capped at `maxBytes`. Request and
 * response headers are never persisted by callers — only status and a sanitized excerpt.
 */
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { parseRetryAfter, sanitizeExcerpt } from './signing';

export interface HttpAttempt {
  status: number | null;
  retryAfterMs: number | null;
  excerpt: string | null;
  durationMs: number;
  errorCode: 'timeout' | 'network' | 'tls' | null;
  errorMessage: string | null;
}

export interface PostOptions {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxBytes: number;
}

export function postPinned(opts: PostOptions): Promise<HttpAttempt> {
  const started = Date.now();
  const pinned: LookupFunction = (_hostname, options, callback) => {
    const o = options as { all?: boolean };
    if (o?.all)
      (callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
        { address: opts.address, family: opts.family },
      ]);
    else callback(null, opts.address, opts.family);
  };
  const isHttps = opts.url.protocol === 'https:';
  const transport = isHttps ? https : http;
  return new Promise<HttpAttempt>((resolve) => {
    let settled = false;
    const finish = (r: Omit<HttpAttempt, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const req = transport.request(
      {
        protocol: opts.url.protocol,
        hostname: opts.url.hostname.replace(/^\[|\]$/g, ''),
        port: opts.url.port || (isHttps ? 443 : 80),
        path: `${opts.url.pathname}${opts.url.search}`,
        method: 'POST',
        headers: { ...opts.headers, 'content-length': Buffer.byteLength(opts.body).toString() },
        lookup: pinned,
        agent: false,
        ...(isHttps ? { servername: opts.url.hostname.replace(/^\[|\]$/g, '') } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () =>
          finish({
            status: res.statusCode ?? null,
            retryAfterMs: parseRetryAfter(res.headers['retry-after'] as string | undefined),
            excerpt: sanitizeExcerpt(Buffer.concat(chunks).toString('utf8')) || null,
            errorCode: null,
            errorMessage: null,
          });
        res.on('data', (c: Buffer) => {
          if (size >= opts.maxBytes) return;
          const room = opts.maxBytes - size;
          chunks.push(c.length > room ? c.subarray(0, room) : c);
          size += Math.min(c.length, room);
          if (size >= opts.maxBytes) {
            // Enough for the excerpt: stop reading and close the socket.
            done();
            res.destroy();
          }
        });
        res.on('end', done);
        res.on('error', done);
      },
    );
    const timer = setTimeout(() => {
      finish({
        status: null,
        retryAfterMs: null,
        excerpt: null,
        errorCode: 'timeout',
        errorMessage: `No response within ${opts.timeoutMs} ms`,
      });
      req.destroy();
    }, opts.timeoutMs);
    req.on('error', (err: NodeJS.ErrnoException) => {
      const tls =
        /certificate|ssl|tls|self.signed/i.test(err.message) ||
        (err.code ?? '').startsWith('ERR_TLS') ||
        (err.code ?? '').includes('CERT');
      finish({
        status: null,
        retryAfterMs: null,
        excerpt: null,
        errorCode: tls ? 'tls' : 'network',
        errorMessage: sanitizeExcerpt(`${err.code ?? 'ERROR'}: ${err.message}`, 300),
      });
    });
    req.end(opts.body);
  });
}
