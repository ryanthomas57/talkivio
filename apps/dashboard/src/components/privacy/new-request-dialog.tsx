'use client';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, Search } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { BRAND_NAME } from '@/components/brand';
import { richT } from '@/components/integrations/rich';
import { Banner, Button, Dialog, DialogContent, Field, Input, RadioGroup, Skeleton } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { useCan } from '@/stores/session';
import { privacyKeys, type PrivacyKind, type PrivacyRequest, type VisitorListItem } from './types';

export function NewRequestDialog({ open, onOpenChange, onCreated, onOpenExisting }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (r: PrivacyRequest) => void; onOpenExisting: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <NewRequestForm onClose={() => onOpenChange(false)} onCreated={onCreated} onOpenExisting={onOpenExisting} />}
    </Dialog>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Sample ticket reference shown in the placeholder (not copy). */
const EVIDENCE_EXAMPLE = 'SUPPORT-4821';

function NewRequestForm({ onClose, onCreated, onOpenExisting }: { onClose: () => void; onCreated: (r: PrivacyRequest) => void; onOpenExisting: (id: string) => void }) {
  const t = useT();
  const canSearch = useCan('visitors.view');
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term.trim(), 300);
  const [visitor, setVisitor] = useState<VisitorListItem | null>(null);
  const [kind, setKind] = useState<PrivacyKind>('access');
  const [proof, setProof] = useState('');
  const [idemKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ visitor?: string; proof?: string }>({});

  const search = useQuery({
    queryKey: privacyKeys.visitorSearch(debounced),
    queryFn: () => api.page<VisitorListItem>('/visitors', { q: debounced, limit: 10 }),
    enabled: canSearch && debounced.length > 0,
    staleTime: 15_000,
  });
  const results = search.data?.items ?? [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof fieldErr = {};
    if (!visitor) fe.visitor = t('privacy.new.visitorRequired');
    if (!proof.trim()) fe.proof = t('privacy.new.proofRequired');
    else if (proof.trim().length > 200) fe.proof = t('privacy.form.maxChars', { max: 200 });
    setFieldErr(fe);
    if (fe.visitor || fe.proof) return;
    setBusy(true);
    setError(null);
    setExisting(null);
    try {
      const r = await api.post<PrivacyRequest>('/privacy/requests', { kind, visitorId: visitor!.id, proofReference: proof.trim() }, { idempotencyKey: idemKey });
      onCreated(r);
      onClose();
    } catch (err) {
      if (isApiError(err, 'CONFLICT') && typeof err.details.requestId === 'string') {
        setExisting(err.details.requestId);
        setError(err.message);
      } else if (isApiError(err)) {
        setFieldErr({ proof: err.field('proof_reference') });
        setError(err.status === 404 ? t('privacy.new.visitorGone') : err.message);
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent
      size="lg"
      title={t('privacy.new.title')}
      description={t('privacy.new.description')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant={kind === 'erase' ? 'danger' : 'primary'} type="submit" form="privacy-request-form" loading={busy}>
            {kind === 'erase' ? t('privacy.new.createErasure') : t('privacy.new.createAccess')}
          </Button>
        </>
      }
    >
      <form id="privacy-request-form" onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {error && (
          <Banner
            tone="danger"
            action={
              existing && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    onOpenExisting(existing);
                    onClose();
                  }}
                >
                  {t('privacy.new.openRequest')}
                </Button>
              )
            }
          >
            {error}
          </Banner>
        )}

        <section aria-labelledby="pr-subject" className="flex flex-col gap-3">
          <h3 id="pr-subject" className="text-sm font-semibold">
            {t('privacy.new.stepSubject')}
          </h3>
          {!canSearch ? (
            <Banner tone="warning">{t('privacy.new.cannotSearch')}</Banner>
          ) : visitor ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-primary/40 bg-primary-tint/40 px-3 py-2.5">
              <VisitorSummary v={visitor} />
              <Button size="sm" variant="secondary" onClick={() => setVisitor(null)}>
                {t('privacy.new.change')}
              </Button>
            </div>
          ) : (
            <>
              <Field label={t('privacy.new.findVisitor')} required description={t('privacy.new.findVisitorHelp')} error={fieldErr.visitor}>
                <div className="relative">
                  <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-2" aria-hidden />
                  <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={t('privacy.new.searchPlaceholder')} className="ps-9" autoFocus autoComplete="off" maxLength={100} type="search" dir="auto" />
                </div>
              </Field>
              <div aria-live="polite" className="flex flex-col gap-2">
                {!debounced ? null : search.isPending ? (
                  <div className="flex flex-col gap-2" aria-busy>
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                  </div>
                ) : search.error ? (
                  <Banner
                    tone="danger"
                    action={
                      <Button size="sm" variant="secondary" onClick={() => void search.refetch()}>
                        {t('common.retry')}
                      </Button>
                    }
                  >
                    {t('privacy.new.searchFailed', { error: errorMessage(search.error) })}
                  </Banner>
                ) : results.length === 0 ? (
                  <p className="text-sm text-fg-2">{t('privacy.new.noMatches', { term: isolate(debounced) })}</p>
                ) : (
                  <ul className="flex flex-col gap-1.5" aria-label={t('privacy.new.matchesLabel')}>
                    {results.map((v) => (
                      <li key={v.id}>
                        <button type="button" onClick={() => setVisitor(v)} className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line px-3 py-2.5 text-start hover:border-primary hover:bg-surface-2">
                          <VisitorSummary v={v} />
                          <span className="shrink-0 text-sm font-medium text-primary">{t('privacy.new.select')}</span>
                        </button>
                      </li>
                    ))}
                    {search.data?.hasMore && <li className="text-xs text-fg-2">{t('privacy.new.moreMatches')}</li>}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>

        <section aria-labelledby="pr-kind" className="flex flex-col gap-2">
          <h3 id="pr-kind" className="text-sm font-semibold">
            {t('privacy.new.stepType')}
          </h3>
          <RadioGroup<PrivacyKind>
            legend={<span className="sr-only">{t('privacy.new.requestType')}</span>}
            name="privacy-kind"
            value={kind}
            onChange={setKind}
            options={[
              {
                value: 'access',
                label: t('privacy.new.accessLabel'),
                description: t('privacy.new.accessDescription', { brand: BRAND_NAME }),
              },
              {
                value: 'erase',
                label: t('privacy.new.eraseLabel'),
                description: t('privacy.new.eraseDescription'),
              },
            ]}
          />
          {kind === 'erase' && (
            <Banner tone="danger" title={t('privacy.new.eraseWarningTitle')}>
              {t('privacy.new.eraseWarningBody')}
            </Banner>
          )}
        </section>

        <section aria-labelledby="pr-proof" className="flex flex-col gap-2">
          <h3 id="pr-proof" className="text-sm font-semibold">
            {t('privacy.new.stepEvidence')}
          </h3>
          <Field label={t('privacy.new.evidence')} required description={t('privacy.new.evidenceHelp')} error={fieldErr.proof}>
            <Input value={proof} onChange={(e) => setProof(e.target.value)} maxLength={200} placeholder={t('privacy.new.evidencePlaceholder', { example: EVIDENCE_EXAMPLE })} autoComplete="off" dir="auto" />
          </Field>
        </section>
      </form>
    </DialogContent>
  );
}

function VisitorSummary({ v }: { v: VisitorListItem }) {
  const t = useT();
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
        <span className="truncate" dir="auto">
          {v.displayName}
        </span>
        {(v.verified || v.identityVerified) && <BadgeCheck className="size-4 shrink-0 text-success" aria-label={t('privacy.new.verifiedIdentity')} />}
      </span>
      <span className={cn('truncate text-xs text-fg-2')}>
        {richT(
          t,
          'privacy.new.visitorMeta',
          {
            email: v.email ? <bdi>{v.email}</bdi> : t('privacy.new.noEmail'),
            time: (
              <time dateTime={v.lastSeenAt} title={formatDateTime(v.lastSeenAt)}>
                {formatRelative(v.lastSeenAt)}
              </time>
            ),
          },
          { count: v.chatCount },
        )}
      </span>
    </span>
  );
}
