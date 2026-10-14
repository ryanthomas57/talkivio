'use client';
import { TRIAL_DAYS, type BillingCycle, type PlanId } from '@talkivio/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { LockKeyhole } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BrandLockup } from '@/components/brand';
import { useReauth } from '@/components/settings/reauth';
import { ThemeToggle } from '@/components/theme-toggle';
import { Banner, Button, Card, CardBody, Skeleton } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import {
  billingKeys,
  BLOCKED_STATES,
  useBillingStatus,
  useBillingSummary,
  usdCents,
  useQuote,
} from '@/lib/billing';
import { homeFor } from '@/lib/navigation';
import { useSession } from '@/stores/session';
import { PlanForm, QuoteAndConsent, type PlanChoice } from './plan-form';
import { PausedScreen } from './paused-screen';
import { useCardCapture } from './use-card';

/**
 * The payment step: a new workspace adds a card to start its free trial, an ended one restarts, and a paused one
 * pays what it owes. The rest of the dashboard is closed until this is done (the API answers 402).
 */
export function BillingSetupPage() {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const tenant = useSession((s) => s.tenant);
  const isOwner = useSession((s) => s.permissions.has('billing.manage'));
  const logout = useSession((s) => s.logout);
  const status = useBillingStatus();
  const summary = useBillingSummary(isOwner);
  const { capture, dialog } = useCardCapture();
  const { guard, dialog: reauthDialog } = useReauth();
  const [choice, setChoice] = useState<PlanChoice | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const state = status.data?.state ?? null;
  const blocked = !!state && BLOCKED_STATES.has(state);
  const mode = state === 'suspended' ? 'paused' : state === 'ended' ? 'restart' : 'trial';

  // Nothing to do here once billing is in order (or off): back to the dashboard.
  useEffect(() => {
    if (status.data && (!status.data.enabled || !blocked) && me) router.replace(homeFor(me));
  }, [status.data, blocked, me, router]);

  useEffect(() => {
    const s = summary.data;
    if (!s?.plan || choice) return;
    setChoice({
      plan: s.plan as PlanId,
      cycle: (s.cycle ?? 'monthly') as BillingCycle,
      seats: Math.max(s.seats ?? 1, s.seatsInUse ?? 1),
    });
  }, [summary.data, choice]);

  const quote = useQuote(
    choice?.plan ?? 'team',
    choice?.cycle ?? 'monthly',
    choice?.seats ?? 1,
    !!choice && mode !== 'paused',
  );

  const finish = async () => {
    await qc.invalidateQueries({ queryKey: ['billing'] });
    const fresh = useSession.getState().me;
    router.replace(fresh ? homeFor(fresh) : '/inbox');
  };

  const addCard = async () => {
    setError(null);
    const r = await capture();
    if (!r.ok) {
      if (r.reason !== 'cancelled')
        setError(
          r.reason === 'declined' ? t('billing.card.declined') : (r.message ?? t('billing.card.failed')),
        );
      return null;
    }
    return r.token;
  };

  const start = async () => {
    if (!choice || !quote.data) return;
    if (!agreed) {
      setConsentError(t('billing.consent.required'));
      return;
    }
    setConsentError(null);
    setBusy(true);
    try {
      const cardToken = await addCard();
      if (!cardToken) return;
      await api.post('/billing/subscribe', {
        ...choice,
        cardToken,
        acceptedTerms: true,
        disclosureHash: quote.data.disclosureHash,
      });
      await finish();
    } catch (e) {
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: billingKeys.quote(choice.plan, choice.cycle, choice.seats) });
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    setBusy(true);
    try {
      const cardToken = await addCard();
      if (!cardToken) return;
      await guard(() => api.put('/billing/card', { cardToken }));
      await finish();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (status.data && blocked && !isOwner) return <PausedScreen state={state!} />;

  const loading = status.isLoading || (isOwner && (summary.isLoading || !choice));
  const workspace = isolate(tenant?.name ?? '');
  return (
    <main id="main" className="relative flex min-h-dvh flex-col items-center bg-canvas px-4 py-10 sm:py-14">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1 [background:var(--brand-gradient)]"
      />
      <ThemeToggle className="absolute end-4 top-4 bg-surface" />
      <BrandLockup className="mb-8" />
      <Card className="w-full max-w-[760px]">
        <CardBody className="flex flex-col gap-6">
          <div>
            <h1 className="text-xl font-semibold text-fg">
              {mode === 'paused'
                ? t('billing.setup.title.paused')
                : mode === 'restart'
                  ? t('billing.setup.title.restart')
                  : t('billing.setup.title.trial', { days: TRIAL_DAYS })}
            </h1>
            <p className="mt-1 text-sm text-fg-2">
              {mode === 'paused'
                ? t('billing.setup.description.paused', { workspace })
                : mode === 'restart'
                  ? t('billing.setup.description.restart', { workspace })
                  : t('billing.setup.description.trial')}
            </p>
          </div>
          {error && <Banner tone="danger">{error}</Banner>}
          {loading ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-10 w-1/2" />
            </div>
          ) : mode === 'paused' ? (
            <Button
              variant="primary"
              size="lg"
              loading={busy}
              onClick={() => void pay()}
              className="self-start"
            >
              {t('billing.cta.pay', { amount: usdCents(summary.data?.periodCents) })}
            </Button>
          ) : (
            choice && (
              <>
                <PlanForm value={choice} onChange={setChoice} minSeats={summary.data?.seatsInUse ?? 1} />
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
                  size="lg"
                  loading={busy}
                  disabled={!quote.data}
                  onClick={() => void start()}
                  className="self-start"
                >
                  {mode === 'trial'
                    ? t('billing.cta.trial')
                    : t('billing.cta.pay', { amount: usdCents(quote.data?.dueNowCents) })}
                </Button>
              </>
            )
          )}
          <p className="flex items-start gap-2 text-xs text-fg-2">
            <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t('billing.card.secure')}
          </p>
        </CardBody>
      </Card>
      <Button
        variant="link"
        className="mt-6 text-sm"
        onClick={() => void logout().then(() => router.replace('/login'))}
      >
        {t('billing.setup.signOut')}
      </Button>
      {dialog}
      {reauthDialog}
    </main>
  );
}
