import { describe, expect, it } from 'vitest';
import { scrubAttributes } from './trace-scrub';

describe('scrubAttributes (spans leave the process without content or personal data)', () => {
  it('strips query strings, client addresses and user agents from server spans', () => {
    const out = scrubAttributes({
      'http.method': 'GET',
      'http.url': 'http://api.example/api/v1/attachments/a1/content?sig=rdg1.secret.token',
      'http.target': '/api/v1/history?q=my%20card%204242',
      'url.full': 'https://user:pw@api.example/api/v1/history?q=secret#frag',
      'url.query': 'q=secret',
      'http.route': '/api/v1/attachments/:id/content',
      'http.client_ip': '203.0.113.7',
      'net.peer.ip': '10.0.0.2',
      'http.user_agent': 'Mozilla/5.0',
      'http.status_code': 200,
    });
    expect(out).toEqual({
      'http.method': 'GET',
      'http.url': 'http://api.example/api/v1/attachments/a1/content',
      'http.target': '/api/v1/history',
      'url.full': 'https://api.example/api/v1/history',
      'http.route': '/api/v1/attachments/:id/content',
      'http.status_code': 200,
    });
  });

  it('keeps only the origin of outgoing calls (webhook paths can embed secrets)', () => {
    const out = scrubAttributes({ 'http.url': 'https://hooks.example.com/services/T0/B0/SECRET?x=1', 'http.target': '/services/T0/B0/SECRET', 'url.path': '/services/T0/B0/SECRET' }, true);
    expect(out).toEqual({ 'http.url': 'https://hooks.example.com', 'http.target': '/', 'url.path': '/' });
  });

  it('keeps database/Redis command names only', () => {
    expect(scrubAttributes({ 'db.statement': 'EVALSHA 3f2a… 8 bull:events:… {"payload":{"body":"hello"}}', 'db.system': 'redis' })).toEqual({ 'db.statement': 'EVALSHA', 'db.system': 'redis' });
    expect(scrubAttributes({ 'db.query.text': 'PUBLISH socket.io#/agent# {"body":"secret"}' })).toEqual({ 'db.query.text': 'PUBLISH' });
  });

  it('drops exception messages and the message line of stack traces', () => {
    const out = scrubAttributes({ 'exception.type': 'Error', 'exception.message': 'bad email someone@example.com', 'exception.stacktrace': 'Error: bad email someone@example.com\n    at f (/app/x.js:1:1)\n    at g (/app/y.js:2:2)' });
    expect(out).toEqual({ 'exception.type': 'Error', 'exception.stacktrace': '    at f (/app/x.js:1:1)\n    at g (/app/y.js:2:2)' });
  });
});
