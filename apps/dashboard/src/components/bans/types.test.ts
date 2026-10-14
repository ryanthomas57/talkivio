import { describe, expect, it } from 'vitest';
import { maskIp } from './types';

// The ban dialog previews what the API will store (apps/api/src/features/visitors/visitor-common.ts maskIp).
describe('maskIp (ban dialog preview)', () => {
  it('masks exact addresses like the API', () => {
    expect(maskIp('203.0.113.7')).toBe('203.0.x.x');
    expect(maskIp('203.0.113.7/32')).toBe('203.0.x.x');
    expect(maskIp('::ffff:203.0.113.7')).toBe('203.0.x.x');
    expect(maskIp('2001:0DB8::1')).toBe('2001:db8:…');
    expect(maskIp('2001:db8::1/128')).toBe('2001:db8:…');
  });

  it('keeps the /64 marker for IPv6 network bans', () => {
    expect(maskIp('2001:db8:1:2::/64')).toBe('2001:db8:…/64');
    expect(maskIp('2001:0:0:0:1:2:3:4/64')).toBe('2001:…/64');
  });

  it('refuses what the API refuses', () => {
    for (const bad of [
      '203.0.113.7/64',
      '203.0.113.7/128',
      '2001:db8::1/32',
      '256.1.1.1',
      '2001:db8::zz',
      'nope',
    ])
      expect(maskIp(bad), bad).toBeNull();
  });
});
