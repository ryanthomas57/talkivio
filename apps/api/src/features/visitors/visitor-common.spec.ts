import { describe, expect, it } from 'vitest';
import { ipBucket } from '../../common/ip';
import { canonicalBanIp, ipBanFilter, maskIp } from './visitor-common';

describe('canonicalBanIp', () => {
  it('canonicalises exact addresses (including /32 and /128 spellings)', () => {
    expect(canonicalBanIp(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(canonicalBanIp('203.0.113.7/32')).toBe('203.0.113.7');
    expect(canonicalBanIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(canonicalBanIp('2001:DB8:0:0::1/128')).toBe('2001:db8::1');
  });

  it('accepts an IPv6 /64 as the same text a visitor address buckets to', () => {
    expect(canonicalBanIp('2001:db8:1:2::/64')).toBe('2001:db8:1:2::/64');
    expect(canonicalBanIp('2001:0db8:0001:0002:abcd::1/64')).toBe('2001:db8:1:2::/64');
    expect(canonicalBanIp('2001:db8:1:2::/64')).toBe(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
  });

  it('refuses other ranges and invalid input', () => {
    for (const bad of [
      '203.0.0.0/16',
      '203.0.113.7/64',
      '::ffff:203.0.113.7/64',
      '2001:db8::/48',
      'nope',
      'nope/64',
    ])
      expect(canonicalBanIp(bad), bad).toBeNull();
  });
});

describe('maskIp', () => {
  it('masks addresses and keeps the /64 marker on network bans', () => {
    expect(maskIp('203.0.113.7')).toBe('203.0.x.x');
    expect(maskIp('2001:db8::1')).toBe('2001:db8:…');
    expect(maskIp('2001:db8:1:2::/64')).toBe('2001:db8:…/64');
  });
});

describe('ipBanFilter', () => {
  it('matches the exact-address hash and the /64 hash', () => {
    expect(ipBanFilter({ ipHash: 'exact', ipNetHash: 'net' })).toEqual([
      { ipMatchHash: { in: ['exact', 'net'] } },
    ]);
  });

  it('deduplicates (IPv4: both hashes are equal) and is empty without an address', () => {
    expect(ipBanFilter({ ipHash: 'same', ipNetHash: 'same' })).toEqual([{ ipMatchHash: { in: ['same'] } }]);
    expect(ipBanFilter({ ipHash: null, ipNetHash: null })).toEqual([]);
  });
});
