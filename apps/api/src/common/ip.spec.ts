import { describe, expect, it } from 'vitest';
import { ipAllowed, ipBucket, ipMatches, isPrivateAddress, normalizeIp } from './ip';

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6 in any spelling', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(normalizeIp('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('leaves IPv4, native IPv6 and junk unchanged', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('2001:DB8:0::1')).toBe('2001:DB8:0::1');
    expect(normalizeIp('not-an-ip')).toBe('not-an-ip');
  });
});

describe('ipBucket (rate-limit key)', () => {
  it('keeps IPv4 addresses exact', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(ipBucket('203.0.113.8')).not.toBe(ipBucket('203.0.113.7'));
  });

  it('treats IPv4-mapped IPv6 as the IPv4 address', () => {
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('collapses every address in an IPv6 /64 to one canonical bucket', () => {
    const bucket = '2001:db8:1:2::/64';
    for (const ip of [
      '2001:db8:1:2::1',
      '2001:db8:1:2:a1b2:c3d4:e5f6:789',
      '2001:0DB8:0001:0002:ffff:ffff:ffff:ffff',
      '2001:db8:1:2::',
    ])
      expect(ipBucket(ip), ip).toBe(bucket);
    expect(ipBucket('2001:db8::5')).toBe('2001:db8::/64');
    expect(ipBucket('fe80::1%eth0')).toBe('fe80::/64');
  });

  it('keeps neighbouring /64s apart', () => {
    expect(ipBucket('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(ipBucket('2001:db8:1:3::1')).not.toBe(ipBucket('2001:db8:1:2::1'));
  });

  it('returns unparseable input trimmed rather than failing', () => {
    expect(ipBucket(' unknown ')).toBe('unknown');
  });
});

describe('ipMatches / ipAllowed (workspace allowlist)', () => {
  it('matches exact addresses and IPv4 CIDR ranges as before', () => {
    expect(ipMatches('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(ipMatches('203.0.113.8', '203.0.113.7')).toBe(false);
    expect(ipMatches('203.0.113.200', '203.0.113.0/24')).toBe(true);
    expect(ipMatches('203.0.114.1', '203.0.113.0/24')).toBe(false);
    expect(ipMatches('10.1.2.3', '10.0.0.0/8')).toBe(true);
  });

  it('matches IPv6 CIDR ranges', () => {
    expect(ipMatches('2001:db8:1:abcd::5', '2001:db8:1::/48')).toBe(true);
    expect(ipMatches('2001:db8:2::5', '2001:db8:1::/48')).toBe(false);
    expect(ipMatches('2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64')).toBe(true);
    expect(ipMatches('2001:db8:1:3::1', '2001:db8:1:2::/64')).toBe(false);
    // Host bits in the rule are ignored, like a router would.
    expect(ipMatches('2001:db8:1:2::9', '2001:db8:1:2::1/64')).toBe(true);
  });

  it('compares IPv6 addresses semantically, not as text', () => {
    expect(ipMatches('2001:db8::1', '2001:DB8:0:0:0:0:0:1')).toBe(true);
    expect(ipMatches('2001:db8:0:0::1', '2001:db8::1')).toBe(true);
    expect(ipMatches('2001:db8::2', '2001:db8::1')).toBe(false);
  });

  it('matches IPv4-mapped clients against IPv4 rules', () => {
    expect(ipMatches('::ffff:203.0.113.7', '203.0.113.0/24')).toBe(true);
    expect(ipMatches('203.0.113.7', '::ffff:203.0.113.7')).toBe(true);
  });

  it('never matches across families', () => {
    expect(ipMatches('203.0.113.7', '::/16')).toBe(false);
    expect(ipMatches('2001:db8::1', '203.0.113.0/24')).toBe(false);
  });

  it('ignores invalid or too-broad rules and junk addresses', () => {
    expect(ipMatches('203.0.113.7', '0.0.0.0/0')).toBe(false);
    expect(ipMatches('2001:db8::1', '::/0')).toBe(false);
    expect(ipMatches('203.0.113.7', 'garbage')).toBe(false);
    expect(ipMatches('garbage', '203.0.113.0/24')).toBe(false);
  });

  it('allows everyone with an empty list and nobody without an address otherwise', () => {
    expect(ipAllowed('2001:db8::1', [])).toBe(true);
    expect(ipAllowed(undefined, ['203.0.113.0/24'])).toBe(false);
    const list = ['203.0.113.0/24', '2001:db8:1::/48'];
    expect(ipAllowed('203.0.113.9', list)).toBe(true);
    expect(ipAllowed('2001:db8:1:ffff::1', list)).toBe(true);
    expect(ipAllowed('2001:db8:2::1', list)).toBe(false);
    expect(ipAllowed('198.51.100.1', list)).toBe(false);
  });
});

describe('isPrivateAddress', () => {
  it('still recognises private, loopback and link-local ranges', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '127.0.0.1',
      '::ffff:10.0.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['203.0.113.7', '172.32.0.1', '2001:db8::1'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });
});
