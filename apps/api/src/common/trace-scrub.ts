/**
 * Export-time scrubbing of trace data (AUD-72-27). Auto-instrumentation records more than traces need: full URLs
 * (download grants carry `?sig=` tokens, searches carry `?q=`), client IP addresses and user agents, Redis command
 * arguments (BullMQ job data, Socket.IO frames) and exception messages (which can quote input). Every span passes
 * through `scrubAttributes` before it leaves the process, so spans keep structure, timing, route templates,
 * identifiers and types — never content, credentials or personal data.
 */
type AttributeValue = string | number | boolean | Array<null | undefined | string> | Array<null | undefined | number> | Array<null | undefined | boolean>;
export type Attributes = Record<string, AttributeValue | undefined>;

/** Client address, user agent and end-user attributes: personal data, never needed to follow a request. */
const DROPPED = new Set([
  'http.client_ip',
  'client.address',
  'client.port',
  'net.peer.ip',
  'net.sock.peer.addr',
  'net.sock.peer.port',
  'network.peer.address',
  'network.peer.port',
  'http.user_agent',
  'user_agent.original',
  'enduser.id',
  'url.query',
  'exception.message',
]);
const URL_KEYS = ['http.url', 'url.full'];
const TARGET_KEYS = ['http.target'];
const STATEMENT_KEYS = ['db.statement', 'db.query.text'];

/** `https://user:pw@host/path?q#f` → `https://host/path` (or only the origin when `originOnly`). */
function cleanUrl(value: string, originOnly: boolean): string {
  try {
    const u = new URL(value);
    return originOnly ? u.origin : `${u.origin}${u.pathname}`;
  } catch {
    return value.split(/[?#]/)[0]!;
  }
}

/**
 * @param attributes span or event attributes
 * @param outgoing   client spans (calls to tenant-configured URLs such as webhooks, whose paths can embed secrets)
 *                   keep only the origin.
 */
export function scrubAttributes(attributes: Attributes, outgoing = false): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (DROPPED.has(key) || value === undefined) continue;
    if (typeof value === 'string' && URL_KEYS.includes(key)) out[key] = cleanUrl(value, outgoing);
    else if (typeof value === 'string' && TARGET_KEYS.includes(key)) out[key] = outgoing ? '/' : value.split(/[?#]/)[0]!;
    else if (typeof value === 'string' && key === 'url.path' && outgoing) out[key] = '/';
    // Commands only: `SET key value` → `SET`, `EVALSHA <sha> <job data…>` → `EVALSHA`.
    else if (typeof value === 'string' && STATEMENT_KEYS.includes(key)) out[key] = value.trim().split(/\s+/)[0] ?? '';
    // The first line of a stack is the error message; the frames below it are code locations.
    else if (typeof value === 'string' && key === 'exception.stacktrace') out[key] = value.split('\n').filter((l) => l.trimStart().startsWith('at ')).join('\n');
    else out[key] = value;
  }
  return out;
}
