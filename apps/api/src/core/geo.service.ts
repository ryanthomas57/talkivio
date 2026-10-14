import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { stat } from 'node:fs/promises';
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
  s = s
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 100);
  return s || null;
}

/** Location headers per edge. Only the edges named in GEO_TRUSTED_HEADERS are read: anywhere else they are client-controlled. */
export const GEO_HEADER_SETS = {
  cloudflare: { country: ['cf-ipcountry'], region: [] as string[], city: ['cf-ipcity'] },
  vercel: {
    country: ['x-vercel-ip-country'],
    region: ['x-vercel-ip-country-region'],
    city: ['x-vercel-ip-city'],
  },
  fastly: { country: ['fastly-geo-country'], region: [] as string[], city: [] as string[] },
  proxy: { country: ['x-country-code'], region: ['x-geo-region'], city: ['x-geo-city'] },
} as const;
export type GeoHeaderSet = keyof typeof GEO_HEADER_SETS;

/** Loopback, private, link-local and unique-local addresses (also IPv4-mapped): they have no location. */
export function isPrivateIp(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

const RELOAD_CHECK_MS = 3600_000;

/**
 * Coarse geolocation. Uses edge/CDN headers only from the edges named in GEO_TRUSTED_HEADERS (Cloudflare, Vercel,
 * Fastly, or your own reverse proxy) — never by default, since a visitor can send any header and country drives
 * triggers — and an optional local MaxMind-format database (GEOIP_DB_PATH, e.g. DB-IP City Lite, reloaded when the
 * file changes). Only country/region/city are derived; raw IPs are never stored. Outside production, GEO_DEV_IP
 * stands in for loopback/private client addresses so local testing shows real locations.
 */
@Injectable()
export class GeoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Geo');
  private reader: { get(ip: string): unknown } | null = null;
  private asnReader: { get(ip: string): unknown } | null = null;
  private trusted: GeoHeaderSet[] = [];
  private devIp: string | null = null;
  private readonly files = {
    city: { path: null as string | null, mtimeMs: 0 },
    asn: { path: null as string | null, mtimeMs: 0 },
  };
  private reloadTimer: NodeJS.Timeout | null = null;

  /** Header trust and the development stand-in address (onModuleInit reads them from the environment). */
  configure(opts: { trustedHeaders?: GeoHeaderSet[]; devIp?: string | null }): void {
    this.trusted = opts.trustedHeaders ?? [];
    this.devIp = opts.devIp ?? null;
  }

  async onModuleInit(): Promise<void> {
    const e = env();
    this.configure({
      trustedHeaders: e.GEO_TRUSTED_HEADERS.split(',')
        .map((s) => s.trim())
        .filter((s): s is GeoHeaderSet => s in GEO_HEADER_SETS),
      devIp: e.NODE_ENV === 'production' ? null : (e.GEO_DEV_IP ?? null),
    });
    // Only the api process looks locations up (sign-in and widget sessions); the city database is ~130 MB in memory.
    if ((process.env.TALKIVIO_PROCESS ?? 'api') !== 'api') return;
    this.files.city.path = e.GEOIP_DB_PATH ?? null;
    this.files.asn.path = e.GEOIP_ASN_DB_PATH ?? null;
    if (!this.files.city.path && !this.files.asn.path) return;
    await this.loadDatabases();
    // Monthly database updates replace the files; pick them up without a restart.
    this.reloadTimer = setInterval(() => void this.loadDatabases(), RELOAD_CHECK_MS);
    this.reloadTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.reloadTimer) clearInterval(this.reloadTimer);
  }

  private async loadDatabases(): Promise<void> {
    for (const kind of ['city', 'asn'] as const) {
      const f = this.files[kind];
      if (!f.path) continue;
      const current = kind === 'city' ? this.reader : this.asnReader;
      try {
        const { mtimeMs } = await stat(f.path);
        if (current && mtimeMs === f.mtimeMs) continue;
        const maxmind = await import('maxmind');
        const opened = await maxmind.open(f.path, { watchForUpdates: false });
        if (kind === 'city') this.reader = opened;
        else this.asnReader = opened;
        f.mtimeMs = mtimeMs;
        this.logger.log(`Loaded GeoIP ${kind} database from ${f.path}`);
      } catch (err) {
        if (!current) this.logger.warn(`GeoIP ${kind} database unavailable: ${(err as Error).message}`);
      }
    }
  }

  /** The address to look up and record: outside production GEO_DEV_IP stands in for loopback/private visitors. */
  effectiveIp(ip: string | null | undefined): string | null {
    return ip && this.devIp && isPrivateIp(ip) ? this.devIp : (ip ?? null);
  }

  /** Network owner of an address (autonomous system organisation: an ISP, or a hosting/VPN provider), if known. */
  network(ip: string | null | undefined): string | null {
    const address = this.effectiveIp(ip);
    if (!address || !this.asnReader) return null;
    try {
      const rec = this.asnReader.get(address) as { autonomous_system_organization?: string } | null;
      return headerText(rec?.autonomous_system_organization ?? null);
    } catch {
      return null;
    }
  }

  lookup(ip: string | null | undefined, headers: IncomingHttpHeaders): GeoInfo {
    const h = (names: readonly string[]) => {
      for (const k of names) {
        const v = headers[k];
        const s = (Array.isArray(v) ? v[0] : v) || null;
        if (s) return s;
      }
      return null;
    };
    const sets = this.trusted.map((t) => GEO_HEADER_SETS[t]);
    let countryCode = h(sets.flatMap((s) => s.country));
    let region = h(sets.flatMap((s) => s.region));
    let city = h(sets.flatMap((s) => s.city));
    const lookupIp = this.effectiveIp(ip);
    if ((!countryCode || countryCode === 'XX') && lookupIp && this.reader) {
      try {
        const rec = this.reader.get(lookupIp) as {
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
    const deviceType: DeviceType = isBot
      ? 'bot'
      : type === 'mobile'
        ? 'mobile'
        : type === 'tablet'
          ? 'tablet'
          : 'desktop';
    return {
      browser: r.browser.name ? `${r.browser.name}${r.browser.major ? ` ${r.browser.major}` : ''}` : null,
      os: r.os.name ? `${r.os.name}${r.os.version ? ` ${r.os.version.split('.')[0]}` : ''}` : null,
      deviceType,
    };
  }
}
