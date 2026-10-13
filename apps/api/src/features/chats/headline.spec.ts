import { describe, expect, it } from 'vitest';
import { splitHeadline } from './chat-queries.service';

describe('splitHeadline', () => {
  it('turns ts_headline markers into plain text and code-point offsets', () => {
    const h = splitHeadline('refund for \u0002order\u0003 👋 \u0002Canada\u0003');
    expect(h.text).toBe('refund for order 👋 Canada');
    const chars = Array.from(h.text);
    expect(h.highlights.map(([s, e]) => chars.slice(s, e).join(''))).toEqual(['order', 'Canada']);
  });

  it('keeps guillemets in message text as ordinary characters', () => {
    const h = splitHeadline('he said «\u0002hello\u0003» twice');
    expect(h.text).toBe('he said «hello» twice');
    expect(h.highlights).toEqual([[9, 14]]);
  });

  it('ignores unbalanced markers', () => {
    expect(splitHeadline('\u0003a\u0002\u0003b').highlights).toEqual([]);
  });
});
