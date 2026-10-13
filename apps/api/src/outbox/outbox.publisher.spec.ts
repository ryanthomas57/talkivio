import { describe, expect, it } from 'vitest';
import { MetricsService } from '../core/metrics.service';
import { OutboxPublisher } from './outbox.publisher';

type Row = Record<string, unknown> & { seq: bigint; event_id: string; audience: string; attempt_count: number };

const row = (seq: number, audience: string, attempt = 1): Row => ({
  seq: BigInt(seq),
  event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  tenant_id: '11111111-1111-4111-8111-111111111111',
  aggregate_type: 'chat',
  aggregate_id: '22222222-2222-4222-8222-222222222222',
  aggregate_version: seq,
  event_type: audience === 'internal' ? 'chat.message_added' : 'message.created',
  scope_kind: 'chat',
  scope_id: '22222222-2222-4222-8222-222222222222',
  audience,
  payload: { n: seq },
  causation_id: null,
  occurred_at: new Date(),
  attempt_count: attempt,
});

/** Publisher wired to in-memory fakes: claimed rows in, emits / jobs / SQL calls out. */
function harness(rows: Row[], opts: { emitFails?: (eventId: string) => boolean; dispatchFails?: boolean } = {}) {
  const emitted: string[] = [];
  const jobs: string[] = [];
  const sql: Array<{ fn: string; seqs: bigint[]; seconds?: number }> = [];
  const db = {
    root: {
      $queryRaw: async () => rows,
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const fn = /rd_\w+/.exec(strings.join(''))?.[0] ?? '?';
        sql.push({ fn, seqs: values[0] as bigint[], seconds: values[1] as number | undefined });
        return 1;
      },
    },
  };
  const realtime = {
    durable: (_ns: string, _room: string, frame: { event_id: string }) => {
      if (opts.emitFails?.(frame.event_id)) throw new Error('unserializable payload');
      emitted.push(frame.event_id);
    },
  };
  const queues = {
    queue: () => ({
      addBulk: async (list: Array<{ data: { eventId: string } }>) => {
        if (opts.dispatchFails) throw new Error('Redis unavailable');
        jobs.push(...list.map((j) => j.data.eventId));
      },
    }),
  };
  const metrics = new MetricsService();
  const publisher = new OutboxPublisher(db as never, {} as never, realtime as never, queues as never, metrics);
  return { publisher, emitted, jobs, sql, metrics };
}

describe('outbox publisher batch', () => {
  it('emits socket rows in sequence order, queues internal rows once and marks the whole batch', async () => {
    const [r1, r2, r3] = [row(1, 'staff'), row(2, 'internal'), row(3, 'public')];
    const h = harness([r3, r1, r2]);
    expect(await h.publisher.publishBatch()).toBe(3);
    expect(h.emitted).toEqual([r1.event_id, r3.event_id]);
    expect(h.jobs).toEqual([r2.event_id]);
    expect(h.sql).toEqual([{ fn: 'rd_mark_outbox_published', seqs: [1n, 3n, 2n], seconds: undefined }]);
  });

  it('defers only the row whose emit throws; the rest of the batch is published', async () => {
    const rows = [row(1, 'staff'), row(2, 'staff'), row(3, 'public')];
    const h = harness(rows, { emitFails: (id) => id === rows[1]!.event_id });
    expect(await h.publisher.publishBatch()).toBe(2);
    expect(h.emitted).toEqual([rows[0]!.event_id, rows[2]!.event_id]);
    expect(h.sql).toEqual([
      { fn: 'rd_mark_outbox_published', seqs: [1n, 3n], seconds: undefined },
      { fn: 'rd_defer_outbox', seqs: [2n], seconds: 1 },
    ]);
    expect(await h.metrics.render()).toMatch(/talkivio_outbox_deferred_total\{service="api"\} 1/);
  });

  it('keeps emitted socket rows published and defers internal rows when the queue is unavailable', async () => {
    const rows = [row(1, 'staff'), row(2, 'internal', 3), row(3, 'internal', 3)];
    const h = harness(rows, { dispatchFails: true });
    expect(await h.publisher.publishBatch()).toBe(1);
    expect(h.sql).toEqual([
      { fn: 'rd_mark_outbox_published', seqs: [1n], seconds: undefined },
      { fn: 'rd_defer_outbox', seqs: [2n, 3n], seconds: 4 },
    ]);
  });

  it('caps the retry backoff at 60 s', async () => {
    const h = harness([row(1, 'staff', 12)], { emitFails: () => true });
    expect(await h.publisher.publishBatch()).toBe(0);
    expect(h.sql).toEqual([{ fn: 'rd_defer_outbox', seqs: [1n], seconds: 60 }]);
  });

  it('returns 0 without touching the database when nothing is claimable', async () => {
    const h = harness([]);
    expect(await h.publisher.publishBatch()).toBe(0);
    expect(h.sql).toEqual([]);
  });
});
