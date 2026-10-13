'use client';
/**
 * Invitation funnel (ch. 21): eligible → displayed → accepted → served, distinct by
 * invitation id, from GET /triggers/{id}/funnel. Conversion percentages are shown
 * only when the previous stage is non-zero.
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { Fragment } from 'react';
import { PanelError, Select, Skeleton } from '@/components/ui';
import { useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { tk, type InvitationFunnel } from './triggers-api';

export type FunnelRange = '7' | '30' | '90' | 'all';

export const FUNNEL_RANGES: FunnelRange[] = ['7', '30', '90', 'all'];

/** Local midnight N days ago, so the query key is stable for the whole day. */
export function rangeStart(range: FunnelRange): string | null {
  if (range === 'all') return null;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(range) + 1).toISOString();
}

export function useFunnel(triggerId: string, range: FunnelRange, enabled = true) {
  const from = rangeStart(range);
  return useQuery({
    queryKey: tk.funnel(triggerId, from),
    queryFn: () => api.get<InvitationFunnel>(`/triggers/${triggerId}/funnel`, { from: from ?? undefined }),
    enabled,
    staleTime: 30_000,
  });
}

/** Conversion with at most one decimal ("33.3%"), in the UI locale. */
function pct(n: number, d: number): string | null {
  if (!d) return null;
  return formatNumber(n / d, { style: 'percent', maximumFractionDigits: 1 });
}

export function FunnelRangeSelect({ value, onChange, id }: { value: FunnelRange; onChange: (v: FunnelRange) => void; id?: string }) {
  const t = useT();
  return (
    <Select id={id} compact value={value} onChange={(e) => onChange(e.target.value as FunnelRange)} aria-label={t('triggers.funnel.rangeLabel')} className="w-40">
      {FUNNEL_RANGES.map((r) => (
        <option key={r} value={r}>
          {r === 'all' ? t('triggers.funnel.allTime') : t('triggers.funnel.lastDays', { count: Number(r) })}
        </option>
      ))}
    </Select>
  );
}

export function FunnelStages({ data, compact }: { data: InvitationFunnel; compact?: boolean }) {
  const t = useT();
  const stages: Array<{ key: string; label: MessageKey; value: number; conv: string | null; convLabel: MessageKey | null; none: MessageKey | null }> = [
    { key: 'eligible', label: 'triggers.funnel.eligible', value: data.eligible, conv: null, convLabel: null, none: null },
    { key: 'displayed', label: 'triggers.funnel.displayed', value: data.displayed, conv: pct(data.displayed, data.eligible), convLabel: 'triggers.funnel.ofEligible', none: 'triggers.funnel.noEligible' },
    { key: 'accepted', label: 'triggers.funnel.accepted', value: data.accepted, conv: pct(data.accepted, data.displayed), convLabel: 'triggers.funnel.ofDisplayed', none: 'triggers.funnel.noDisplayed' },
    { key: 'served', label: 'triggers.funnel.served', value: data.served, conv: pct(data.served, data.accepted), convLabel: 'triggers.funnel.ofAccepted', none: 'triggers.funnel.noAccepted' },
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className={cn('grid gap-2', compact ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-center')}>
        {stages.map((s, i) => (
          <Fragment key={s.key}>
            {!compact && i > 0 && <ArrowRight className="hidden size-4 justify-self-center text-fg-3 rtl:-scale-x-100 lg:block" aria-hidden />}
            <div className="flex flex-col gap-0.5 rounded-[var(--radius-control)] border border-line-subtle bg-surface-2 px-3 py-2">
              <dt className="text-xs font-medium text-fg-2">{t(s.label)}</dt>
              <dd className="text-lg font-semibold tabular text-fg">{formatNumber(s.value)}</dd>
              {i > 0 && s.convLabel && s.none && <dd className="text-xs text-fg-2">{s.conv ? t(s.convLabel, { pct: s.conv }) : t(s.none)}</dd>}
            </div>
          </Fragment>
        ))}
      </dl>
      <p className="text-xs text-fg-2">{t('triggers.funnel.also', { dismissed: data.dismissed, expired: data.expired })}</p>
    </div>
  );
}

export function FunnelPanel({ triggerId, range, compact }: { triggerId: string; range: FunnelRange; compact?: boolean }) {
  const q = useFunnel(triggerId, range);
  if (q.isPending)
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-busy>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  if (q.isError) return <PanelError className="p-0" message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  return <FunnelStages data={q.data} compact={compact} />;
}
