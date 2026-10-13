import { describe, expect, it } from 'vitest';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('exports every metric it declares (a counter that is incremented but never registered is invisible)', async () => {
    const m = new MetricsService();
    const declared = Object.values(m)
      .map((v) => (v as { def?: { name?: string } } | null)?.def?.name)
      .filter((n): n is string => typeof n === 'string');
    const text = await m.render();
    expect(declared.length).toBeGreaterThan(15);
    expect(declared.filter((name) => !text.includes(`# TYPE ${name} `))).toEqual([]);
  });

  it('samples resident memory and counts slow-consumer closes', async () => {
    const m = new MetricsService();
    m.socketOverloads.inc(m.labels({ namespace: 'agent' }));
    const text = await m.render();
    expect(text).toMatch(/^talkivio_socket_overloads_total\{[^}]*namespace="agent"[^}]*\} 1$/m);
    expect(Number(/^talkivio_process_resident_memory_bytes\{[^}]*\} (\d+)/m.exec(text)?.[1])).toBeGreaterThan(1_000_000);
  });
});
