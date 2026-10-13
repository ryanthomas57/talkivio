import { describe, expect, it } from 'vitest';
import { isOverloaded, OUTBOUND_MAX_BYTES, OUTBOUND_MAX_PACKETS } from './gateway';

describe('slow-consumer guard (ch. 47 outbound buffer: 1000 events or 1 MiB)', () => {
  it('keeps healthy connections', () => {
    expect(isOverloaded({ writeBuffer: [], transport: { socket: { bufferedAmount: 0 } } })).toBe(false);
    expect(isOverloaded({ writeBuffer: new Array(OUTBOUND_MAX_PACKETS), transport: { socket: { bufferedAmount: OUTBOUND_MAX_BYTES } } })).toBe(false);
    expect(isOverloaded({})).toBe(false);
  });

  it('flags more than 1000 queued packets', () => {
    expect(isOverloaded({ writeBuffer: new Array(OUTBOUND_MAX_PACKETS + 1) })).toBe(true);
  });

  it('flags more than 1 MiB buffered on the transport', () => {
    expect(isOverloaded({ writeBuffer: [], transport: { socket: { bufferedAmount: OUTBOUND_MAX_BYTES + 1 } } })).toBe(true);
  });
});
