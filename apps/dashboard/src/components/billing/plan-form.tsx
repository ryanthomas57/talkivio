'use client';
import { PLAN_CATALOG, PLAN_IDS, unitPriceCents, type BillingCycle, type PlanId } from '@talkivio/contracts';
import { Minus, Plus } from 'lucide-react';
import Link from 'next/link';
import { Button, Checkbox, Skeleton } from '@/components/ui';
import { useT, type MessageKey } from '@/i18n';
import type { BillingQuote } from '@/lib/billing';
import { usdCents } from '@/lib/billing';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

export interface PlanChoice {
  plan: PlanId;
  cycle: BillingCycle;
  seats: number;
}

const BLURB: Record<PlanId, MessageKey> = {
  starter: 'billing.plan.starter.blurb',
  team: 'billing.plan.team.blurb',
  business: 'billing.plan.business.blurb',
};

/** Plan, billing cycle and number of agents. */
export function PlanForm({
  value,
  onChange,
  minSeats,
  current,
}: {
  value: PlanChoice;
  onChange: (v: PlanChoice) => void;
  minSeats: number;
  /** The plan the workspace is on now, marked in the list. */
  current?: PlanId;
}) {
  const t = useT();
  const set = (patch: Partial<PlanChoice>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">{t('billing.plan.legend')}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {PLAN_IDS.map((id) => {
            const p = PLAN_CATALOG[id];
            const checked = value.plan === id;
            return (
              <label
                key={id}
                className={cn(
                  'relative flex cursor-pointer flex-col gap-1 rounded-[var(--radius-control)] border p-3 transition-colors',
                  checked ? 'border-primary bg-primary-tint' : 'border-line hover:border-primary/60',
                )}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="plan"
                    value={id}
                    checked={checked}
                    onChange={() => set({ plan: id })}
                    className="size-4 accent-[var(--primary)]"
                  />
                  <span className="text-sm font-semibold text-fg">{p.name}</span>
                  {current === id && (
                    <span className="ms-auto text-xs text-fg-2">{t('billing.plan.current')}</span>
                  )}
                </span>
                <span className="text-sm text-fg">
                  {t('billing.plan.price', { price: usdCents(unitPriceCents(id, value.cycle)) })}
                </span>
                <span className="text-xs text-fg-2">{t(BLURB[id])}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">{t('billing.cycle.legend')}</legend>
        <div className="flex flex-wrap gap-2">
          {(['monthly', 'yearly'] as const).map((c) => (
            <label
              key={c}
              className={cn(
                'flex min-h-10 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border px-3 text-sm',
                value.cycle === c ? 'border-primary bg-primary-tint text-fg' : 'border-line text-fg',
              )}
            >
              <input
                type="radio"
                name="cycle"
                value={c}
                checked={value.cycle === c}
                onChange={() => set({ cycle: c })}
                className="size-4 accent-[var(--primary)]"
              />
              {t(c === 'monthly' ? 'billing.cycle.monthly' : 'billing.cycle.yearly')}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="billing-seats" className="mb-2 block text-sm font-medium text-fg">
          {t('billing.seats.label')}
        </label>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label={t('billing.seats.decrease')}
            disabled={value.seats <= Math.max(1, minSeats)}
            onClick={() => set({ seats: value.seats - 1 })}
          >
            <Minus className="size-4" aria-hidden />
          </Button>
          <input
            id="billing-seats"
            type="number"
            inputMode="numeric"
            min={Math.max(1, minSeats)}
            max={500}
            value={value.seats}
            onChange={(e) => set({ seats: Math.min(500, Math.max(1, Number(e.target.value) || 1)) })}
            aria-describedby="billing-seats-help"
            className="h-9 w-20 rounded-[var(--radius-control)] border border-line bg-surface px-2 text-center text-sm text-fg"
          />
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label={t('billing.seats.increase')}
            disabled={value.seats >= 500}
            onClick={() => set({ seats: value.seats + 1 })}
          >
            <Plus className="size-4" aria-hidden />
          </Button>
        </div>
        <p id="billing-seats-help" className="mt-1.5 text-xs text-fg-2">
          {t('billing.seats.help', { count: minSeats })}
        </p>
      </div>
    </div>
  );
}

/** The price and the automatic-renewal wording, with the explicit agreement. */
export function QuoteAndConsent({
  quote,
  loading,
  agreed,
  onAgree,
  error,
}: {
  quote: BillingQuote | undefined;
  loading: boolean;
  agreed: boolean;
  onAgree: (v: boolean) => void;
  error?: string | null;
}) {
  const t = useT();
  if (loading || !quote)
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <span className="sr-only">{t('billing.quote.loading')}</span>
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 rounded-[var(--radius-control)] border border-line bg-surface-2 p-4 text-sm">
        <div>
          <dt className="text-fg-2">{t('billing.quote.dueToday')}</dt>
          <dd className="text-lg font-semibold text-fg">{usdCents(quote.dueNowCents)}</dd>
        </div>
        {quote.nextChargeAt && (
          <div>
            <dt className="text-fg-2">
              {t('billing.quote.chargedOn', { date: formatDate(quote.nextChargeAt) })}
            </dt>
            <dd className="text-lg font-semibold text-fg">{usdCents(quote.periodCents)}</dd>
          </div>
        )}
      </dl>
      {quote.disclosure && (
        <div>
          <h3 className="mb-1 text-sm font-medium text-fg">{t('billing.quote.terms')}</h3>
          {/* The exact wording stored with the agreement (English, as the Terms are). */}
          <p
            className="rounded-[var(--radius-control)] border border-line-subtle bg-surface p-3 text-sm leading-6 text-fg"
            lang="en"
            dir="ltr"
          >
            {quote.disclosure}
          </p>
        </div>
      )}
      <div className="flex items-start gap-3">
        <Checkbox
          id="billing-consent"
          checked={agreed}
          onCheckedChange={(v) => onAgree(v === true)}
          aria-describedby={error ? 'billing-consent-error' : undefined}
          aria-invalid={!!error}
          className="mt-0.5"
        />
        <label htmlFor="billing-consent" className="text-sm leading-6 text-fg">
          {t('billing.consent.label')}
        </label>
      </div>
      <p className="text-xs text-fg-2">
        <Link href="/legal/terms" target="_blank" className="text-primary underline underline-offset-2">
          {t('billing.consent.terms')}
        </Link>
        {' · '}
        <Link href="/legal/privacy" target="_blank" className="text-primary underline underline-offset-2">
          {t('billing.consent.privacy')}
        </Link>
        {' · '}
        <Link
          href="/legal/refund-policy"
          target="_blank"
          className="text-primary underline underline-offset-2"
        >
          {t('billing.consent.refund')}
        </Link>
      </p>
      {error && (
        <p id="billing-consent-error" className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
