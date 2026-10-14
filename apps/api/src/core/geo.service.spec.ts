import { describe, expect, it } from 'vitest';
import { GeoService, headerText, isPrivateIp } from './geo.service';

/** Edge geo headers are untrusted text: they must never fail a request or break the country CHECK. */
describe('GeoService.lookup', () => {
  const geo = new GeoService();
  geo.configure({ trustedHeaders: ['cloudflare', 'vercel', 'fastly', 'proxy'] });
  const look = (headers: Record<string, string>) => geo.lookup(null, headers);

  it('accepts ISO alpha-2 country codes in any case', () => {
    expect(look({ 'cf-ipcountry': 'ae' }).countryCode).toBe('AE');
    expect(look({ 'x-vercel-ip-country': ' GB ' }).countryCode).toBe('GB');
  });

  it('drops values that are not ISO alpha-2 (the visitor_sessions.country CHECK would reject them)', () => {
    for (const bad of ['1', 'U', 'U1', 'USA', 'É1', '--', 'XX', 'T1', 'xx'])
      expect(look({ 'x-country-code': bad }).countryCode, bad).toBeNull();
  });

  it('decodes well-formed region/city headers and keeps malformed ones as text instead of throwing', () => {
    expect(look({ 'x-vercel-ip-city': 'S%C3%A3o%20Paulo', 'x-vercel-ip-country-region': 'SP' })).toEqual({
      countryCode: null,
      region: 'SP',
      city: 'São Paulo',
    });
    expect(() => look({ 'x-geo-city': '%E0%A4%A', 'x-geo-region': '%' })).not.toThrow();
    expect(look({ 'x-geo-city': '%E0%A4%A' }).city).toBe('%E0%A4%A');
  });
});

describe('GeoService header trust', () => {
  it('ignores every location header by default: a visitor could otherwise pick their country (it drives triggers)', () => {
    const geo = new GeoService();
    expect(
      geo.lookup(null, {
        'cf-ipcountry': 'US',
        'x-vercel-ip-country': 'US',
        'fastly-geo-country': 'US',
        'x-country-code': 'US',
        'x-geo-city': 'Paris',
      }),
    ).toEqual({ countryCode: null, region: null, city: null });
  });

  it('reads only the configured edge', () => {
    const geo = new GeoService();
    geo.configure({ trustedHeaders: ['cloudflare'] });
    expect(
      geo.lookup(null, { 'x-vercel-ip-country': 'US', 'cf-ipcountry': 'AE', 'cf-ipcity': 'Dubai' }),
    ).toEqual({ countryCode: 'AE', region: null, city: 'Dubai' });
    expect(geo.lookup(null, { 'x-vercel-ip-country': 'US' }).countryCode).toBeNull();
  });
});

describe('GeoService development stand-in address', () => {
  const fake = {
    get: (ip: string) =>
      ip === '203.0.113.7' ? { country: { iso_code: 'AE' }, city: { names: { en: 'Dubai' } } } : null,
  };
  const withReader = (devIp: string | null) => {
    const geo = new GeoService();
    geo.configure({ devIp });
    (geo as unknown as { reader: typeof fake }).reader = fake;
    return geo;
  };

  it('looks up GEO_DEV_IP for loopback and private visitors', () => {
    expect(withReader('203.0.113.7').lookup('127.0.0.1', {})).toEqual({
      countryCode: 'AE',
      region: null,
      city: 'Dubai',
    });
    expect(withReader('203.0.113.7').lookup('::ffff:192.168.1.20', {}).countryCode).toBe('AE');
  });

  it('never replaces a public visitor address, and does nothing without a stand-in', () => {
    expect(withReader('203.0.113.7').lookup('198.51.100.9', {}).countryCode).toBeNull();
    expect(withReader(null).lookup('127.0.0.1', {}).countryCode).toBeNull();
  });
});

describe('isPrivateIp', () => {
  it('recognises loopback, private, link-local and unique-local addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.10',
      '169.254.1.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '198.51.100.9', '2001:db8::1', '::ffff:8.8.4.4'])
      expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe('headerText', () => {
  it('removes control characters, trims and bounds the text', () => {
    expect(headerText('Dubai\u0000\r\n')).toBe('Dubai');
    expect(headerText('%0A%0D')).toBeNull();
    expect(headerText('a'.repeat(500))).toHaveLength(100);
    expect(headerText(null)).toBeNull();
  });
});
