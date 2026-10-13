import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedisService } from '../common/redis.service';
import { AGENT_NS, CONGESTED_ROOM, RealtimeService } from './realtime.service';

/**
 * Ephemeral delivery against a real Socket.IO server (ch. 47). Regression: frames used Socket.IO's `volatile`
 * flag, which drops every frame of a same-tick burst after the first — live visitor deltas and typing updates
 * emitted in a loop never reached agents. Ephemeral frames now skip only sockets marked congested.
 */
describe('RealtimeService ephemeral frames', () => {
  let http: HttpServer;
  let ioServer: Server;
  let client: ClientSocket;
  const realtime = new RealtimeService({} as RedisService);
  const ephemeral: number[] = [];
  const durable: string[] = [];

  beforeAll(async () => {
    http = createServer();
    ioServer = new Server(http);
    const ns = ioServer.of(AGENT_NS);
    realtime.attach(ns);
    ns.on('connection', (s) => void s.join('room-a'));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    client = io(`http://127.0.0.1:${(http.address() as AddressInfo).port}${AGENT_NS}`, {
      transports: ['websocket'],
      forceNew: true,
    });
    client.on('ephemeral', (f: { payload: { n: number } }) => ephemeral.push(f.payload.n));
    client.on('event', (f: { event_id: string }) => durable.push(f.event_id));
    await new Promise<void>((r) => client.on('connect', () => r()));
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    client.close();
    await new Promise<void>((r) => ioServer.close(() => r()));
  });

  const settle = () => new Promise((r) => setTimeout(r, 300));

  it('delivers every frame of a same-tick burst to a healthy socket', async () => {
    for (let n = 0; n < 5; n++)
      realtime.ephemeral(AGENT_NS, 'room-a', 'visitor.updated', { kind: 'visitor', id: 'all' }, { n });
    await settle();
    expect(ephemeral).toEqual([0, 1, 2, 3, 4]);
  });

  it('skips a congested socket for ephemeral frames but still delivers durable ones', async () => {
    const [server] = await ioServer.of(AGENT_NS).fetchSockets();
    server.join(CONGESTED_ROOM);
    ephemeral.length = 0;
    for (let n = 0; n < 3; n++)
      realtime.ephemeral(AGENT_NS, 'room-a', 'typing.changed', { kind: 'chat', id: 'c' }, { n });
    realtime.durable(AGENT_NS, 'room-a', {
      v: 1,
      event_id: 'e1',
      type: 'message.created',
      tenant_id: 't',
      scope: { kind: 'chat', id: 'c' },
      cursor: 'c1',
      occurred_at: new Date(0).toISOString(),
      aggregate_version: 1,
      causation_id: null,
      payload: {},
    });
    await settle();
    expect(ephemeral).toEqual([]);
    expect(durable).toEqual(['e1']);
    server.leave(CONGESTED_ROOM);
    realtime.ephemeral(AGENT_NS, 'room-a', 'typing.changed', { kind: 'chat', id: 'c' }, { n: 9 });
    await settle();
    expect(ephemeral).toEqual([9]);
  });
});
