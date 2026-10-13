'use client';
/**
 * Live server-rendered preview of the text in the editor, saved or not
 * (POST /shortcuts/render-preview {body, options, sample}; nothing is stored or
 * sent). Requests are debounced while typing and superseded ones are aborted.
 * Sample values are editable; an empty value counts as missing, so tokens without
 * a fallback stay as `{{key}}` and are listed as unresolved — exactly what the
 * composer would block.
 */
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Banner, Field, Input, Skeleton } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useT } from '@/i18n';
import { MAX_BODY, PLACEHOLDERS, type PlaceholderKey, type RenderResult } from './shortcuts-api';

type Samples = Record<PlaceholderKey, string>;

const EMPTY: Samples = { 'visitor.name': '', 'agent.display_name': '', 'department.name': '', 'site.name': '' };
/** Wait this long after the last keystroke before asking the server. */
const DEBOUNCE_MS = 300;

export function ShortcutPreview({ body, options }: { body: string; options: string[] }) {
  const t = useT();
  const [samples, setSamples] = useState<Samples>(EMPTY);
  const [result, setResult] = useState<RenderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const empty = !body.trim();
  // The API accepts up to twice the save limit so an over-long draft still previews.
  const tooLong = body.length > MAX_BODY * 2;
  const key = JSON.stringify([body, options, samples]);

  useEffect(() => {
    if (empty || tooLong) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const sample = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.trim() ? v : null]));
      api
        .post<RenderResult>('/shortcuts/render-preview', { body, options: options.map((o) => o.trim()).filter(Boolean), sample }, { signal: ctrl.signal })
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((e) => {
          if (ctrl.signal.aborted) return;
          setError(errorMessage(e));
        })
        .finally(() => !ctrl.signal.aborted && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, empty, tooLong]);

  return (
    <section aria-labelledby="preview-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 id="preview-heading" className="text-sm font-semibold text-fg">
          {t('common.preview')}
        </h3>
        <p className="text-xs text-fg-2">{t('shortcuts.preview.help')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {PLACEHOLDERS.map((p) => (
          <Field key={p.key} label={t(p.label)} description={<span dir="ltr">{`{{${p.key}}}`}</span>}>
            <Input value={samples[p.key]} maxLength={200} dir="auto" onChange={(e) => setSamples((s) => ({ ...s, [p.key]: e.target.value }))} placeholder={t('shortcuts.preview.missing')} />
          </Field>
        ))}
      </div>
      <div aria-live="polite" aria-busy={loading || undefined}>
        {empty ? (
          <p className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-sm text-fg-2">{t('shortcuts.preview.empty')}</p>
        ) : tooLong ? (
          <Banner tone="warning">{t('shortcuts.preview.tooLong', { max: formatNumber(MAX_BODY) })}</Banner>
        ) : error ? (
          <Banner tone="danger">{error}</Banner>
        ) : !result ? (
          <Skeleton className="h-24" />
        ) : (
          <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <RenderedText result={result} />
          </div>
        )}
      </div>
    </section>
  );
}

function RenderedText({ result }: { result: RenderResult }) {
  const t = useT();
  const parts = useMemo(() => highlight(result.text, result.unresolved), [result.text, result.unresolved]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {result.canSend ? (
          <Badge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden />}>
            {t('shortcuts.preview.ready')}
          </Badge>
        ) : (
          <Badge tone="warning" icon={<AlertTriangle className="size-3.5" aria-hidden />}>
            {t('shortcuts.preview.unresolved', { count: result.unresolved.length })}
          </Badge>
        )}
        {result.unresolved.map((u) => (
          <code key={u} dir="ltr" className="rounded bg-warning-tint px-1.5 py-0.5 text-xs text-warning">{`{{${u}}}`}</code>
        ))}
      </div>
      <div dir="auto" className="whitespace-pre-wrap break-words rounded-[var(--radius-control)] border border-line-subtle bg-surface-2 px-3 py-2.5 text-sm leading-6 text-fg">
        {parts.map((p, i) =>
          p.unresolved ? (
            <mark key={i} className="rounded bg-warning-tint px-0.5 font-medium text-warning ring-1 ring-warning/40">
              {p.text}
              <span className="sr-only"> {t('shortcuts.preview.unresolvedMark')}</span>
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </div>
      {result.options.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-fg-2">{t('shortcuts.preview.options')}</p>
          <ul className="flex flex-wrap gap-1.5">
            {result.options.map((o) => (
              <li key={o} dir="auto" className="rounded-full border border-primary/40 px-3 py-1 text-sm text-primary">
                {o}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Split rendered text so unresolved `{{key}}` tokens (as returned by the API) can be marked. */
function highlight(text: string, unresolved: string[]): Array<{ text: string; unresolved: boolean }> {
  if (!unresolved.length) return [{ text, unresolved: false }];
  const tokens = unresolved.map((k) => `{{${k}}}`);
  const out: Array<{ text: string; unresolved: boolean }> = [];
  let rest = text;
  while (rest) {
    let best = -1;
    let tok = '';
    for (const token of tokens) {
      const i = rest.indexOf(token);
      if (i >= 0 && (best < 0 || i < best)) {
        best = i;
        tok = token;
      }
    }
    if (best < 0) {
      out.push({ text: rest, unresolved: false });
      break;
    }
    if (best > 0) out.push({ text: rest.slice(0, best), unresolved: false });
    out.push({ text: tok, unresolved: true });
    rest = rest.slice(best + tok.length);
  }
  return out;
}
