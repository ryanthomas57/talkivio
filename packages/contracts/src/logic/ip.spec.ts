import { describe, expect, it } from 'vitest';
import { ipRuleSchema } from '../schemas';
import { formatIpv6, mappedIpv4, parseIpRule, parseIpv4, parseIpv6 } from './ip';

describe('parseIpv4', () => {
  it('parses dotted quads', () => {
    expect(parseIpv4('0.0.0.0')).toBe(0);
    expect(parseIpv4('203.0.113.7')).toBe(((203 * 256 + 0) * 256 + 113) * 256 + 7);
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff);
  });

  it('rejects anything else', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.-4', '1.2.3.4 ', 'a.b.c.d'])
      expect(parseIpv4(bad), bad).toBeNull();
  });
});

describe('parseIpv6 / formatIpv6', () => {
  it('expands compressed forms', () => {
    expect(parseIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('2001:DB8::')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('2001:db8:0:0:1:0:0:1')).toEqual([0x2001, 0xdb8, 0, 0, 1, 0, 0, 1]);
    expect(parseIpv6('::ffff:192.0.2.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc000, 0x201]);
  });

  it('rejects malformed addresses and zone ids', () => {
    for (const bad of [
      '',
      '1.2.3.4',
      '1::2::3',
      ':1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4::5:6:7:8',
      '12345::',
      'g::1',
      'fe80::1%eth0',
      '::ffff:300.1.1.1',
    ])
      expect(parseIpv6(bad), bad).toBeNull();
  });

  it('formats per RFC 5952 (first longest zero run, lowercase, no leading zeros)', () => {
    expect(formatIpv6(parseIpv6('2001:0DB8:0000:0000:0001:0000:0000:0001')!)).toBe('2001:db8::1:0:0:1');
    expect(formatIpv6(parseIpv6('2001:db8:0:1:1:1:1:1')!)).toBe('2001:db8:0:1:1:1:1:1');
    expect(formatIpv6(parseIpv6('2001:db8:1:2::')!)).toBe('2001:db8:1:2::');
    expect(formatIpv6(parseIpv6('0:0:0:0:0:0:0:0')!)).toBe('::');
  });
});

describe('mappedIpv4', () => {
  it('recognises IPv4-mapped addresses in dotted and hex spelling', () => {
    expect(mappedIpv4(parseIpv6('::ffff:203.0.113.7')!)).toBe('203.0.113.7');
    expect(mappedIpv4(parseIpv6('::FFFF:cb00:7107')!)).toBe('203.0.113.7');
    expect(mappedIpv4(parseIpv6('0:0:0:0:0:ffff:cb00:7107')!)).toBe('203.0.113.7');
  });

  it('ignores other IPv6 addresses', () => {
    expect(mappedIpv4(parseIpv6('::cb00:7107')!)).toBeNull();
    expect(mappedIpv4(parseIpv6('64:ff9b::cb00:7107')!)).toBeNull();
    expect(mappedIpv4(parseIpv6('2001:db8::1')!)).toBeNull();
  });
});

describe('parseIpRule (workspace allowlist entries)', () => {
  it('accepts exact addresses and canonicalises them', () => {
    expect(parseIpRule(' 203.0.113.7 ')).toEqual({ family: 4, address: '203.0.113.7', prefix: 32 });
    expect(parseIpRule('2001:DB8:0::1')).toEqual({ family: 6, address: '2001:db8::1', prefix: 128 });
    expect(parseIpRule('::ffff:203.0.113.7')).toEqual({ family: 4, address: '203.0.113.7', prefix: 32 });
  });

  it('accepts IPv4 /8 to /32 and IPv6 /16 to /128 ranges', () => {
    expect(parseIpRule('10.0.0.0/8')).toEqual({ family: 4, address: '10.0.0.0', prefix: 8 });
    expect(parseIpRule('203.0.113.0/24')?.prefix).toBe(24);
    expect(parseIpRule('2001:db8:1::/48')).toEqual({ family: 6, address: '2001:db8:1::', prefix: 48 });
    expect(parseIpRule('2001:db8::/16')?.prefix).toBe(16);
    expect(parseIpRule('2001:db8::1/128')?.prefix).toBe(128);
  });

  it('rejects ranges that are too broad, out of bounds or malformed', () => {
    for (const bad of [
      '',
      '10.0.0.0/7',
      '0.0.0.0/0',
      '1.2.3.4/33',
      '::/0',
      '2000::/15',
      '2001:db8::/129',
      '2001:db8::/064x',
      '2001:db8::/',
      '1.2.3.4/24/1',
      '::ffff:10.0.0.0/104',
      'example.com',
    ])
      expect(parseIpRule(bad), bad).toBeNull();
  });

  it('backs the settings schema used when the allowlist is saved', () => {
    expect(ipRuleSchema.safeParse('2001:db8:1::/48').success).toBe(true);
    expect(ipRuleSchema.safeParse('203.0.113.0/24').success).toBe(true);
    expect(ipRuleSchema.safeParse('2001:db8::/8').success).toBe(false);
    expect(ipRuleSchema.safeParse('2001:db8::zz').success).toBe(false);
  });
});
