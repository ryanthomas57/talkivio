import { countryName, GeoService } from '../core/geo.service';
import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthSession, User } from '@prisma/client';
import { TenantDb } from '../db/tenant-db';
import { hashIp, randomToken, sha256 } from '../common/crypto';
import { env, isProd } from '../config/env';
import { RealtimeService } from '../realtime/realtime.service';

export const SESSION_COOKIE = 'rd_session';
export const CSRF_COOKIE = 'rd_csrf';
export const DEVICE_COOKIE = 'rd_device';
export const CSRF_HEADER = 'x-csrf-token';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

export type SessionWithUser = AuthSession & { user: User };

function summarizeUa(ua: string | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

/** Opaque session cookies (hashed at rest) with a session-bound CSRF token. */
@Injectable()
export class SessionService {
  constructor(
    private readonly db: TenantDb,
    private readonly realtime: RealtimeService,
    private readonly geo: GeoService,
  ) {}

  /** Approximate sign-in location ("City, Country" or country only) — never the IP itself. */
  private locationLabel(req: Request): string | null {
    const g = this.geo.lookup(req.ip ?? null, req.headers);
    const country = countryName(g.countryCode);
    const label = [g.city, country].filter(Boolean).join(', ');
    return label ? label.slice(0, 120) : null;
  }

  cookieOptions(maxAgeMs: number, httpOnly = true) {
    const e = env();
    return {
      httpOnly,
      sameSite: 'lax' as const,
      secure: e.COOKIE_SECURE || isProd(),
      domain: e.COOKIE_DOMAIN || undefined,
      path: '/',
      maxAge: maxAgeMs,
    };
  }

  /** Create a fresh session (new id on every login / privilege change → no fixation). */
  async create(user: Pick<User, 'id'>, req: Request, res: Response, activeTenantId: string | null): Promise<AuthSession> {
    const token = randomToken(32);
    const csrf = randomToken(24);
    const session = await this.db.root.authSession.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        csrfTokenHash: sha256(csrf),
        activeTenantId,
        mfaVerified: true,
        recentAuthAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        uaSummary: summarizeUa(req.headers['user-agent']),
        ipHash: hashIp(req.ip),
        locationLabel: this.locationLabel(req),
      },
    });
    await this.db.root.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    res.cookie(SESSION_COOKIE, token, this.cookieOptions(SESSION_TTL_MS));
    res.cookie(CSRF_COOKIE, csrf, this.cookieOptions(SESSION_TTL_MS, false));
    return session;
  }

  /** Rotate token + CSRF while keeping the session record (privilege change). */
  async rotate(sessionId: string, res: Response): Promise<void> {
    const token = randomToken(32);
    const csrf = randomToken(24);
    await this.db.root.authSession.update({ where: { id: sessionId }, data: { tokenHash: sha256(token), csrfTokenHash: sha256(csrf) } });
    res.cookie(SESSION_COOKIE, token, this.cookieOptions(SESSION_TTL_MS));
    res.cookie(CSRF_COOKIE, csrf, this.cookieOptions(SESSION_TTL_MS, false));
  }

  tokenFrom(req: Request): string | null {
    const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
    return raw && raw.length > 20 ? raw : null;
  }

  async resolveToken(token: string): Promise<SessionWithUser | null> {
    const session = await this.db.root.authSession.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.user.disabledAt) return null;
    if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.root.authSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
    }
    return session;
  }

  async resolve(req: Request): Promise<SessionWithUser | null> {
    const token = this.tokenFrom(req);
    return token ? this.resolveToken(token) : null;
  }

  checkCsrf(req: Request, session: AuthSession): boolean {
    const header = req.header(CSRF_HEADER);
    return !!header && sha256(header) === session.csrfTokenHash;
  }

  async setActiveTenant(sessionId: string, tenantId: string | null): Promise<void> {
    await this.db.root.authSession.update({ where: { id: sessionId }, data: { activeTenantId: tenantId } });
  }

  async markRecentAuth(sessionId: string): Promise<void> {
    await this.db.root.authSession.update({ where: { id: sessionId }, data: { recentAuthAt: new Date() } });
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.root.authSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    this.realtime.revokeSession(sessionId);
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const sessions = await this.db.root.authSession.findMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      select: { id: true },
    });
    for (const s of sessions) await this.revoke(s.id);
    return sessions.length;
  }

  clear(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { ...this.cookieOptions(0), maxAge: undefined });
    res.clearCookie(CSRF_COOKIE, { ...this.cookieOptions(0, false), maxAge: undefined });
  }
}
