import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { UAParser } from 'ua-parser-js';
import type { DeviceType } from '@talkivio/contracts';
import { env } from '../config/env';

export interface GeoInfo {
  countryCode: string | null;
  region: string | null;
  city: string | null;
}

export interface ClientInfo {
  browser: string | null;
  os: string | null;
  deviceType: DeviceType;
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** A region/city header as display text: percent-decoded when well formed, control characters removed, bounded. */
export function headerText(v: string | null | undefined): string | null {
  if (!v) return null;
  let s = v;
  try {
    s = decodeURIComponent(v);
  } catch {
    /* malformed escape: keep the raw header text rather than failing the request */
  }
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return s || null;
}

/**
 * Coarse geolocation. Uses edge/CDN headers when present (Cloudflare, Vercel,
 * Fastly, or a reverse proxy) and an optional local MaxMind database. Only
 * country/region/city are derived; raw IPs are never stored.
 */
@Injectable()
export class GeoService implements OnModuleInit {
  private readonly logger = new Logger('Geo');
  private reader: { get(ip: string): unknown } | null = null;

  async onModuleInit(): Promise<void> {
    const path = env().GEOIP_DB_PATH;
    if (!path) return;
    try {
      const maxmind = await import('maxmind');
      this.reader = await maxmind.open(path);
      this.logger.log(`Loaded GeoIP database from ${path}`);
    } catch (err) {
      this.logger.warn(`GeoIP database unavailable: ${(err as Error).message}`);
    }
  }

  lookup(ip: string | null | undefined, headers: IncomingHttpHeaders): GeoInfo {
    const h = (k: string) => {
      const v = headers[k];
      return (Array.isArray(v) ? v[0] : v) || null;
    };
    let countryCode = h('cf-ipcountry') ?? h('x-vercel-ip-country') ?? h('fastly-geo-country') ?? h('x-country-code');
    let region = h('x-vercel-ip-country-region') ?? h('x-geo-region');
    let city = h('cf-ipcity') ?? h('x-vercel-ip-city') ?? h('x-geo-city');
    if ((!countryCode || countryCode === 'XX') && ip && this.reader) {
      try {
        const rec = this.reader.get(ip) as {
          country?: { iso_code?: string };
          subdivisions?: Array<{ names?: { en?: string } }>;
          city?: { names?: { en?: string } };
        } | null;
        countryCode = rec?.country?.iso_code ?? null;
        region = rec?.subdivisions?.[0]?.names?.en ?? region;
        city = rec?.city?.names?.en ?? city;
      } catch {
        /* ignore lookup errors */
      }
    }
    const cc = countryCode?.trim().toUpperCase() ?? null;
    return {
      // ISO 3166-1 alpha-2 only (visitor_sessions.country has the same CHECK); XX/T1 are the "unknown"/Tor markers.
      countryCode: cc && /^[A-Z]{2}$/.test(cc) && cc !== 'XX' && cc !== 'T1' ? cc : null,
      region: headerText(region),
      city: headerText(city),
    };
  }

  parseUserAgent(ua: string | null | undefined): ClientInfo {
    if (!ua) return { browser: null, os: null, deviceType: 'unknown' };
    const r = new UAParser(ua).getResult();
    const type = r.device.type;
    const isBot = /bot|crawler|spider|crawling|headless/i.test(ua);
    const deviceType: DeviceType = isBot ? 'bot' : type === 'mobile' ? 'mobile' : type === 'tablet' ? 'tablet' : 'desktop';
    return {
      browser: r.browser.name ? `${r.browser.name}${r.browser.major ? ` ${r.browser.major}` : ''}` : null,
      os: r.os.name ? `${r.os.name}${r.os.version ? ` ${r.os.version.split('.')[0]}` : ''}` : null,
      deviceType,
    };
  }
}
