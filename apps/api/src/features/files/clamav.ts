/**
 * ClamAV `clamd` client speaking the INSTREAM protocol over TCP (no dependency).
 *
 *   -> "zINSTREAM\0"
 *   -> repeated [uint32 big-endian length][chunk bytes]
 *   -> [0x00000000]                       (end of stream)
 *   <- "stream: OK\0" | "stream: <Signature> FOUND\0" | "<message> ERROR\0"
 */
import { Socket } from 'node:net';

export type ScanVerdict = { status: 'clean' } | { status: 'infected'; signature: string };

/** Scanner could not give a verdict (down, timeout, protocol or size error) — retry later. */
export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerUnavailableError';
  }
}

const CHUNK = 64 * 1024;

/** Parses a clamd reply line (exported for unit tests). */
export function parseClamdReply(reply: string): ScanVerdict {
  const line = reply.replace(/\0/g, '').trim();
  if (/^(?:stream|[^:]*):\s*OK$/.test(line)) return { status: 'clean' };
  const found = /^(?:stream|[^:]*):\s*(.+?)\s+FOUND$/.exec(line);
  if (found) return { status: 'infected', signature: found[1]!.slice(0, 200) };
  throw new ScannerUnavailableError(`clamd error: ${line.slice(0, 200) || 'empty reply'}`);
}

function exchange(host: string, port: number, timeoutMs: number, write: (sock: Socket) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value ?? '');
    };
    const timer = setTimeout(() => done(new ScannerUnavailableError(`clamd timed out after ${timeoutMs} ms`)), timeoutMs);
    sock.on('error', (err) => done(new ScannerUnavailableError(`clamd connection failed: ${(err as NodeJS.ErrnoException).code ?? err.message}`)));
    sock.on('data', (d: Buffer) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      if (all.includes(0)) done(null, all.toString('utf8'));
    });
    sock.on('end', () => {
      const all = Buffer.concat(chunks);
      if (all.length) done(null, all.toString('utf8'));
      else done(new ScannerUnavailableError('clamd closed the connection without a reply'));
    });
    sock.connect(port, host, () => write(sock));
  });
}

export async function clamdPing(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  try {
    const reply = await exchange(host, port, timeoutMs, (s) => s.write('zPING\0'));
    return reply.replace(/\0/g, '').trim() === 'PONG';
  } catch {
    return false;
  }
}

/** Streams `data` to clamd and returns its verdict; throws ScannerUnavailableError when no verdict. */
export async function clamdScan(data: Buffer, opts: { host: string; port: number; timeoutMs: number }): Promise<ScanVerdict> {
  const reply = await exchange(opts.host, opts.port, opts.timeoutMs, (sock) => {
    sock.write('zINSTREAM\0');
    for (let off = 0; off < data.length; off += CHUNK) {
      const part = data.subarray(off, Math.min(off + CHUNK, data.length));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(part.length, 0);
      sock.write(len);
      sock.write(part);
    }
    sock.write(Buffer.alloc(4));
  });
  return parseClamdReply(reply);
}
