import { describe, expect, it } from 'vitest';
import { GeoService, headerText } from './geo.service';

/** Edge geo headers are untrusted text: they must never fail a request or break the country CHECK. */
describe('GeoService.lookup', () => {
  const geo = new GeoService();
  const look = (headers: Record<string, string>) => geo.lookup(null, headers);

  it('accepts ISO alpha-2 country codes in any case', () => {
    expect(look({ 'cf-ipcountry': 'ae' }).countryCode).toBe('AE');
    expect(look({ 'x-vercel-ip-country': ' GB ' }).countryCode).toBe('GB');
  });

  it('drops values that are not ISO alpha-2 (the visitor_sessions.country CHECK would reject them)', () => {
    for (const bad of ['1', 'U', 'U1', 'USA', 'É1', '--', 'XX', 'T1', 'xx']) expect(look({ 'x-country-code': bad }).countryCode, bad).toBeNull();
  });

  it('decodes well-formed region/city headers and keeps malformed ones as text instead of throwing', () => {
    expect(look({ 'x-vercel-ip-city': 'S%C3%A3o%20Paulo', 'x-vercel-ip-country-region': 'SP' })).toEqual({ countryCode: null, region: 'SP', city: 'São Paulo' });
    expect(() => look({ 'x-geo-city': '%E0%A4%A', 'x-geo-region': '%' })).not.toThrow();
    expect(look({ 'x-geo-city': '%E0%A4%A' }).city).toBe('%E0%A4%A');
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
