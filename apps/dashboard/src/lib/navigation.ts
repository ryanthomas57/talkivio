import type { Me } from './types';

/** Only same-origin relative paths are honoured as post-login destinations. */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  return next;
}

/** Where to land after authentication. */
export function homeFor(me: Me, next?: string | null): string {
  if (!me.activeTenantId) return '/workspaces';
  const membership = me.memberships.find((m) => m.tenantId === me.activeTenantId);
  if (membership && !membership.onboardingCompleted && (membership.role === 'owner' || membership.role === 'admin')) return '/onboarding';
  return safeNext(next) ?? (membership?.role === 'analyst' ? '/analytics' : '/inbox');
}
