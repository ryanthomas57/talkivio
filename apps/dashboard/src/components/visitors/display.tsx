'use client';
/**
 * Display helpers for visitor data: sanitized URL labels, device and approximate
 * location wording, identity badges, and durations that tick from a server
 * baseline (value at the server `as_of` + monotonic time elapsed since receipt —
 * never the client wall clock against server timestamps).
 */
import { BadgeCheck, CircleUser, Monitor, Smartphone, Tablet, HelpCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { isolate, useT, type MessageKey } from '@/i18n';
import { countryName, formatDuration, formatDurationLong } from '@/lib/format';

/** Monotonic milliseconds (performance.now) — immune to client clock changes. */
export const mono = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Re-render on a shared monotonic tick. */
export function useMonoNow(ms = 1000): number {
  const [now, setNow] = useState(mono);
  useEffect(() => {
    const t = setInterval(() => setNow(mono()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Value at receipt + monotonic time elapsed since receipt. */
export function ticking(baseMs: number | null | undefined, receivedAt: number, now: number): number | null {
  if (baseMs === null || baseMs === undefined || !Number.isFinite(baseMs)) return null;
  return Math.max(0, baseMs + Math.max(0, now - receivedAt));
}

export function Elapsed({ ms, className }: { ms: number | null; className?: string }) {
  if (ms === null) return null;
  return (
    <span className={cn('tabular', className)} aria-label={formatDurationLong(ms)}>
      {formatDuration(ms)}
    </span>
  );
}

/** Host + path (+ query) of an already server-sanitized URL; never a script URL. */
export function urlLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    let path = u.pathname;
    try {
      path = decodeURI(path);
    } catch {
      /* keep encoded */
    }
    return `${u.host}${path === '/' ? '/' : path}${u.search}`;
  } catch {
    return raw.replace(/^https?:\/\//, '').slice(0, 2000);
  }
}

/** Only http(s) URLs become links. */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function originLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//, '');
  }
}

const DEVICE: Record<string, { label: MessageKey; Icon: typeof Monitor }> = {
  desktop: { label: 'visitors.device.desktop', Icon: Monitor },
  mobile: { label: 'visitors.device.mobile', Icon: Smartphone },
  tablet: { label: 'visitors.device.tablet', Icon: Tablet },
};

export function DeviceLabel({
  category,
  className,
}: {
  category: string | null | undefined;
  className?: string;
}) {
  const t = useT();
  if (!category) return <span className={cn('text-fg-3', className)}>{t('common.unknown')}</span>;
  const known = DEVICE[category];
  const d = known
    ? { label: t(known.label), Icon: known.Icon }
    : { label: category.charAt(0).toUpperCase() + category.slice(1), Icon: HelpCircle };
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <d.Icon className="size-3.5 shrink-0 text-fg-2" aria-hidden />
      {d.label}
    </span>
  );
}

/** Country from IP geolocation — always presented as approximate. */
export function ApproxCountry({ code, className }: { code: string | null | undefined; className?: string }) {
  const t = useT();
  if (!code) return <span className={cn('text-fg-3', className)}>{t('common.unknown')}</span>;
  const name = countryName(code) ?? code;
  return (
    <Tooltip content={t('visitors.display.approxTooltip')}>
      <span
        className={cn('inline-flex items-center gap-1', className)}
        tabIndex={0}
        aria-label={t('visitors.display.approxLabel', { country: name })}
      >
        <span aria-hidden className="text-fg-2">
          ≈
        </span>
        <span className="truncate">{name}</span>
      </span>
    </Tooltip>
  );
}

/** Verified identity vs anonymous / visitor-provided (unverified) details. */
export function IdentityBadge({
  verified,
  identified,
  compact,
}: {
  verified: boolean;
  identified?: boolean;
  compact?: boolean;
}) {
  const t = useT();
  if (verified)
    return (
      <Badge
        tone="success"
        icon={<BadgeCheck className="size-3.5" aria-hidden />}
        title={t('visitors.display.verifiedTitle')}
      >
        {compact ? t('visitors.display.verified') : t('visitors.display.verifiedIdentity')}
      </Badge>
    );
  if (identified)
    return (
      <Badge
        tone="neutral"
        icon={<CircleUser className="size-3.5" aria-hidden />}
        title={t('visitors.display.unverifiedTitle')}
      >
        {t('visitors.display.unverified')}
      </Badge>
    );
  return (
    <Badge
      tone="neutral"
      icon={<CircleUser className="size-3.5" aria-hidden />}
      title={t('visitors.display.anonymousTitle')}
    >
      {t('visitors.display.anonymous')}
    </Badge>
  );
}

/** Truncated page label; the full sanitized URL appears on hover and keyboard focus. */
export function PageCell({
  url,
  title,
  hidden,
}: {
  url: string | null;
  title?: string | null;
  hidden?: boolean;
}) {
  const t = useT();
  if (hidden) return <span className="text-xs text-fg-3">{t('visitors.display.pageHidden')}</span>;
  if (!url) return null;
  const label = urlLabel(url);
  return (
    <Tooltip
      content={
        <span className="block break-all">
          {title ? (
            <span className="mb-0.5 block font-semibold" dir="auto">
              {title}
            </span>
          ) : null}
          <span dir="auto">{label}</span>
        </span>
      }
    >
      <span
        tabIndex={0}
        dir="auto"
        className="block min-w-0 truncate rounded-sm"
        aria-label={
          title
            ? t('visitors.display.currentPageWithTitle', { title: isolate(title), url: isolate(label) })
            : t('visitors.display.currentPage', { url: isolate(label) })
        }
      >
        {label}
      </span>
    </Tooltip>
  );
}
