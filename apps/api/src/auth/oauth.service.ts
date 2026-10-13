import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantDb } from '../db/tenant-db';
import { randomToken, sha256 } from '../common/crypto';
import { AppError } from '../common/http';
import { env } from '../config/env';
import { SessionService } from './session.service';

type Provider = 'google' | 'github';

interface ProviderProfile {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  avatarUrl: string | null;
}

/** OAuth 2.0 sign-in (authorization code flow) for Google and GitHub. */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger('OAuth');

  constructor(
    private readonly db: TenantDb,
    private readonly sessions: SessionService,
  ) {}

  enabledProviders(): Provider[] {
    const e = env();
    const out: Provider[] = [];
    if (e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET) out.push('google');
    if (e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET) out.push('github');
    return out;
  }

  private callbackUrl(provider: Provider): string {
    return `${env().APP_URL}/api/v1/auth/oauth/${provider}/callback`;
  }

  async start(provider: Provider, redirect: string | undefined, res: Response): Promise<void> {
    if (!this.enabledProviders().includes(provider)) throw new AppError(422, 'INTEGRATION_UNAVAILABLE', 'This sign-in method is not configured');
    const state = randomToken(24);
    const safeRedirect = redirect && redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/inbox';
    await this.db.root.authToken.create({
      data: { purpose: 'oauth_state', tokenHash: sha256(state), payload: { provider, redirect: safeRedirect }, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    });
    res.cookie('rd_oauth_state', state, this.sessions.cookieOptions(10 * 60 * 1000));
    const e = env();
    const url =
      provider === 'google'
        ? `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
            client_id: e.GOOGLE_CLIENT_ID!,
            redirect_uri: this.callbackUrl(provider),
            response_type: 'code',
            scope: 'openid email profile',
            state,
            prompt: 'select_account',
          })}`
        : `https://github.com/login/oauth/authorize?${new URLSearchParams({
            client_id: e.GITHUB_CLIENT_ID!,
            redirect_uri: this.callbackUrl(provider),
            scope: 'read:user user:email',
            state,
          })}`;
    res.redirect(url);
  }

  async callback(provider: Provider, code: string | undefined, state: string | undefined, req: Request, res: Response): Promise<void> {
    const appUrl = env().APP_URL;
    const fail = (reason: string) => res.redirect(`${appUrl}/login?error=${encodeURIComponent(reason)}`);
    try {
      const cookieState = (req as Request & { cookies?: Record<string, string> }).cookies?.rd_oauth_state;
      if (!code || !state || !cookieState || cookieState !== state) return fail('oauth_state');
      const record = await this.db.root.authToken.findUnique({ where: { tokenHash: sha256(state) } });
      if (!record || record.consumedAt || record.expiresAt < new Date() || record.purpose !== 'oauth_state') return fail('oauth_state');
      await this.db.root.authToken.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
      res.clearCookie('rd_oauth_state', { path: '/' });
      const data = record.payload as { provider: Provider; redirect: string };
      if (data.provider !== provider) return fail('oauth_state');

      const profile = provider === 'google' ? await this.googleProfile(code) : await this.githubProfile(code);
      if (!profile.emailVerified) return fail('email_unverified');

      const linked = await this.db.root.oAuthAccount.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId: profile.id } },
      });
      let userId = linked?.userId;
      if (!userId) {
        const email = profile.email.toLowerCase();
        const existing = await this.db.root.user.findUnique({ where: { email } });
        const user =
          existing ??
          (await this.db.root.user.create({
            data: { email, displayName: (profile.name || email.split('@')[0]).slice(0, 120), avatarUrl: profile.avatarUrl && profile.avatarUrl.length <= 2048 && /^https:\/\//.test(profile.avatarUrl) ? profile.avatarUrl : null, emailVerifiedAt: new Date() },
          }));
        await this.db.root.oAuthAccount.create({ data: { userId: user.id, provider, providerAccountId: profile.id } });
        userId = user.id;
      }
      const user = await this.db.root.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.mfaEnabledAt) {
        // OAuth does not bypass the second factor: send the user to complete MFA with a password-less challenge.
        return fail('mfa_required_use_password');
      }
      await this.sessions.create({ id: userId }, req, res, null);
      res.redirect(`${appUrl}${data.redirect}`);
    } catch (err) {
      this.logger.error(`OAuth callback failed: ${(err as Error).message}`);
      fail('oauth_failed');
    }
  }

  private async googleProfile(code: string): Promise<ProviderProfile> {
    const e = env();
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: e.GOOGLE_CLIENT_ID!,
        client_secret: e.GOOGLE_CLIENT_SECRET!,
        redirect_uri: this.callbackUrl('google'),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) throw new Error('No access token from Google');
    const info = (await (
      await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } })
    ).json()) as { sub: string; email: string; email_verified: boolean; name?: string; picture?: string };
    return { id: info.sub, email: info.email, emailVerified: info.email_verified, name: info.name ?? '', avatarUrl: info.picture ?? null };
  }

  private async githubProfile(code: string): Promise<ProviderProfile> {
    const e = env();
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: e.GITHUB_CLIENT_ID, client_secret: e.GITHUB_CLIENT_SECRET, code, redirect_uri: this.callbackUrl('github') }),
    });
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) throw new Error('No access token from GitHub');
    const headers = { authorization: `Bearer ${tokens.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'talkivio' };
    const user = (await (await fetch('https://api.github.com/user', { headers })).json()) as { id: number; name?: string; login: string; avatar_url?: string };
    const emails = (await (await fetch('https://api.github.com/user/emails', { headers })).json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find((m) => m.primary && m.verified) ?? emails.find((m) => m.verified);
    if (!primary) throw new Error('No verified GitHub email');
    return { id: String(user.id), email: primary.email, emailVerified: true, name: user.name ?? user.login, avatarUrl: user.avatar_url ?? null };
  }
}
