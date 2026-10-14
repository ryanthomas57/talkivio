'use client';
import { PLAN_CATALOG, type BillingCycle, type PlanId } from '@talkivio/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useReauth, isReauthCancelled } from '@/components/settings/reauth';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Page,
  PageHeader,
  PanelError,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
  type BadgeTone,
} from '@/components/ui';
import { useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import {
  useBillingCharges,
  useBillingSummary,
  usdCents,
  useQuote,
  type BillingCharge,
  type BillingState,
  type BillingSummary,
} from '@/lib/billing';
import { formatDate } from '@/lib/format';
import { PlanForm, QuoteAndConsent, type PlanChoice } from './plan-form';
import { useCardCapture } from './use-card';

const STATE: Record<BillingState, { label: MessageKey; tone: BadgeTone }> = {
  incomplete: { label: 'billing.state.incomplete', tone: 'warning' },
  trialing: { label: 'billing.state.trialing', tone: 'info' },
  active: { label: 'billing.state.active', tone: 'success' },
  past_due: { label: 'billing.state.past_due', tone: 'danger' },
  suspended: { label: 'billing.state.suspended', tone: 'danger' },
  ended: { label: 'billing.state.ended', tone: 'neutral' },
};

const planName = (p: string | undefined | null) =>
  p && p in PLAN_CATALOG ? PLAN_CATALOG[p as PlanId].name : (p ?? '');

/** Settings, Billing (owner): the subscription, the card, plan changes, cancellation and invoices. */
export function BillingSettings() {
  const t = useT();
  const qc = useQueryClient();
  const summary = useBillingSummary();
  const s = summary.data;
  const live = !!s?.enabled && !s.exempt && !!s.state;
  const charges = useBillingCharges(live);
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing'] });

  return (
    <Page>
      <PageHeader title={t('billing.page.title')} description={t('billing.page.description')} />
      {summary.isLoading ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : summary.error ? (
        <PanelError message={errorMessage(summary.error)} onRetry={() => void summary.refetch()} />
      ) : !s?.enabled || s.exempt || !s.state ? (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">{t(!s?.enabled ? 'billing.off' : 'billing.exempt')}</p>
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <SubscriptionCard s={s} onChanged={refresh} />
          <CardCard s={s} onChanged={refresh} />
          {(s.state === 'trialing' || s.state === 'active') && <ChangePlanCard s={s} onChanged={refresh} />}
          <InvoicesCard rows={charges.data} loading={charges.isLoading} />
        </div>
      )}
    </Page>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-sm text-fg-2">{label}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  );
}

function SubscriptionCard({ s, onChanged }: { s: BillingSummary; onChanged: () => void }) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const state = STATE[s.state!];
  const cycle = t(s.cycle === 'yearly' ? 'billing.cycle.yearlyLower' : 'billing.cycle.monthlyLower');
  const period = t(s.cycle === 'yearly' ? 'billing.period.year' : 'billing.period.month');
  const endsOn = s.state === 'trialing' ? s.trialEndsAt : s.currentPeriodEnd;
  const resume = async () => {
    try {
      await api.post('/billing/resume', {});
      toast.success(t('billing.resume.done'));
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card>
      <CardHeader
        title={t('billing.summary.title')}
        action={<Badge tone={state.tone}>{t(state.label)}</Badge>}
      />
      <CardBody className="flex flex-col gap-4">
        {s.state === 'past_due' && (
          <Banner tone="danger">
            {t('billing.summary.pastDue', { reason: s.lastError ?? '', date: formatDate(s.graceEndsAt) })}
          </Banner>
        )}
        {s.cancelAtPeriodEnd && endsOn && (
          <Banner tone="warning">{t('billing.summary.cancelled', { date: formatDate(endsOn) })}</Banner>
        )}
        {s.pending && s.currentPeriodEnd && (
          <Banner tone="info">
            {t('billing.summary.pending', {
              date: formatDate(s.currentPeriodEnd),
              plan: planName(s.pending.plan),
              seats: s.pending.seats,
              cycle: t(
                s.pending.cycle === 'yearly' ? 'billing.cycle.yearlyLower' : 'billing.cycle.monthlyLower',
              ),
            })}
          </Banner>
        )}
        <dl className="flex flex-col gap-3">
          <Row label={t('billing.summary.plan')}>
            {t('billing.summary.planValue', { plan: planName(s.plan), cycle })}
          </Row>
          <Row label={t('billing.summary.agents')}>
            {t('billing.summary.agentsValue', { seats: s.seats ?? 0, used: s.seatsInUse ?? 0 })}
          </Row>
          <Row label={t('billing.summary.price')}>
            {t('billing.summary.priceValue', { amount: usdCents(s.periodCents), period })}
          </Row>
          {s.state === 'trialing' && s.trialEndsAt && (
            <Row label={t('billing.summary.trialEnds')}>{formatDate(s.trialEndsAt)}</Row>
          )}
          {s.nextChargeAt && s.nextChargeCents != null && (
            <Row label={t('billing.summary.nextCharge')}>
              {t('billing.summary.nextChargeValue', {
                amount: usdCents(s.nextChargeCents),
                date: formatDate(s.nextChargeAt),
              })}
            </Row>
          )}
        </dl>
        {(s.state === 'trialing' || s.state === 'active' || s.state === 'past_due') && (
          <div className="flex flex-wrap gap-2">
            {s.cancelAtPeriodEnd ? (
              <Button variant="primary" onClick={() => void resume()}>
                {t('billing.resume.button')}
              </Button>
            ) : (
              <Button variant="danger-ghost" onClick={() => setConfirm(true)}>
                {t('billing.cancel.button')}
              </Button>
            )}
          </div>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        danger
        title={t('billing.cancel.title')}
        description={t('billing.cancel.body', { date: formatDate(endsOn ?? new Date().toISOString()) })}
        confirmLabel={t('billing.cancel.button')}
        onConfirm={async () => {
          await api.post('/billing/cancel', {});
          toast.success(t('billing.cancel.done'));
          onChanged();
        }}
      />
    </Card>
  );
}

function CardCard({ s, onChanged }: { s: BillingSummary; onChanged: () => void }) {
  const t = useT();
  const { capture, dialog } = useCardCapture();
  const { guard, dialog: reauthDialog } = useReauth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await capture();
      if (!r.ok) {
        if (r.reason !== 'cancelled')
          setError(
            r.reason === 'declined' ? t('billing.card.declined') : (r.message ?? t('billing.card.failed')),
          );
        return;
      }
      await guard(() => api.put('/billing/card', { cardToken: r.token }));
      toast.success(t('billing.card.updated'));
      onChanged();
    } catch (e) {
      if (!isReauthCancelled(e)) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title={t('billing.card.title')} />
      <CardBody className="flex flex-col gap-3">
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="flex flex-wrap items-center gap-3">
          <CreditCard className="size-5 text-fg-2" aria-hidden />
          {s.card ? (
            <span className="text-sm text-fg">
              {t('billing.card.value', { brand: s.card.brand ?? '', last4: s.card.last4 })}
              {s.card.exp && (
                <span className="ms-2 text-fg-2">
                  {t('billing.card.expires', { exp: `${s.card.exp.slice(0, 2)}/${s.card.exp.slice(2)}` })}
                </span>
              )}
            </span>
          ) : (
            <span className="text-sm text-fg-2">{t('billing.card.none')}</span>
          )}
          {s.state !== 'ended' && (
            <Button variant="secondary" className="ms-auto" loading={busy} onClick={() => void update()}>
              {t('billing.card.update')}
            </Button>
          )}
        </div>
        <p className="text-xs text-fg-2">{t('billing.card.secure')}</p>
      </CardBody>
      {dialog}
      {reauthDialog}
    </Card>
  );
}

function ChangePlanCard({ s, onChanged }: { s: BillingSummary; onChanged: () => void }) {
  const t = useT();
  const current: PlanChoice = {
    plan: (s.pending?.plan ?? s.plan ?? 'team') as PlanId,
    cycle: (s.pending?.cycle ?? s.cycle ?? 'monthly') as BillingCycle,
    seats: s.pending?.seats ?? s.seats ?? 1,
  };
  const [choice, setChoice] = useState<PlanChoice>(current);
  const [agreed, setAgreed] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = choice.plan !== s.plan || choice.cycle !== s.cycle || choice.seats !== s.seats;
  const quote = useQuote(choice.plan, choice.cycle, choice.seats, changed);
  useEffect(() => setAgreed(false), [choice.plan, choice.cycle, choice.seats]);

  const submit = async () => {
    if (!quote.data) return;
    if (!agreed) {
      setConsentError(t('billing.consent.required'));
      return;
    }
    setConsentError(null);
    setError(null);
    setBusy(true);
    try {
      await api.patch('/billing/subscription', {
        ...choice,
        acceptedTerms: true,
        disclosureHash: quote.data.disclosureHash,
      });
      toast.success(t('billing.change.done'));
      setAgreed(false);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t('billing.change.title')} description={t('billing.change.description')} />
      <CardBody className="flex flex-col gap-5">
        {error && <Banner tone="danger">{error}</Banner>}
        <PlanForm value={choice} onChange={setChoice} minSeats={s.seatsInUse ?? 1} current={s.plan} />
        {changed ? (
          <>
            <QuoteAndConsent
              quote={quote.data}
              loading={quote.isLoading}
              agreed={agreed}
              onAgree={setAgreed}
              error={consentError}
            />
            {quote.error && <Banner tone="danger">{errorMessage(quote.error)}</Banner>}
            <Button
              variant="primary"
              loading={busy}
              disabled={!quote.data}
              onClick={() => void submit()}
              className="self-start"
            >
              {t('billing.change.submit')}
            </Button>
          </>
        ) : (
          <p className="text-sm text-fg-2">{t('billing.change.same')}</p>
        )}
      </CardBody>
    </Card>
  );
}

const KIND: Record<string, MessageKey> = {
  first: 'billing.invoices.kind.first',
  renewal: 'billing.invoices.kind.renewal',
  retry: 'billing.invoices.kind.retry',
  proration: 'billing.invoices.kind.proration',
};
const STATUS: Record<BillingCharge['status'], { label: MessageKey; tone: BadgeTone }> = {
  approved: { label: 'billing.invoices.status.approved', tone: 'success' },
  declined: { label: 'billing.invoices.status.declined', tone: 'danger' },
  error: { label: 'billing.invoices.status.error', tone: 'warning' },
};

function InvoicesCard({ rows, loading }: { rows: BillingCharge[] | undefined; loading: boolean }) {
  const t = useT();
  return (
    <Card>
      <CardHeader title={t('billing.invoices.title')} />
      {loading ? (
        <CardBody>
          <Skeleton className="h-20 w-full" />
        </CardBody>
      ) : !rows?.length ? (
        <CardBody>
          <EmptyState title={t('billing.invoices.empty')} />
        </CardBody>
      ) : (
        <TableScroll>
          <Table>
            <THead>
              <TR>
                <TH>{t('billing.invoices.date')}</TH>
                <TH>{t('billing.invoices.number')}</TH>
                <TH>{t('billing.invoices.item')}</TH>
                <TH className="text-end">{t('billing.invoices.amount')}</TH>
                <TH>{t('billing.invoices.status')}</TH>
              </TR>
            </THead>
            <tbody>
              {rows.map((c) => (
                <TR key={c.id}>
                  <TD>{formatDate(c.createdAt)}</TD>
                  <TD className="font-mono text-xs">{c.invoiceNumber}</TD>
                  <TD>
                    {t(KIND[c.kind] ?? 'billing.invoices.kind.renewal')}
                    <span className="block text-xs text-fg-2">
                      {t('billing.invoices.line', {
                        plan: planName(c.plan),
                        seats: c.seats,
                        cycle: t(
                          c.cycle === 'yearly' ? 'billing.cycle.yearlyLower' : 'billing.cycle.monthlyLower',
                        ),
                      })}
                    </span>
                  </TD>
                  <TD className="text-end tabular-nums">{usdCents(c.amountCents)}</TD>
                  <TD>
                    <Badge tone={STATUS[c.status].tone}>{t(STATUS[c.status].label)}</Badge>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      )}
    </Card>
  );
}
