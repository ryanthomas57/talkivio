'use client';
/**
 * Search-and-pick a visitor record (GET /visitors?q=). Results are a native radio
 * list so arrow keys and screen readers work without custom widgets.
 */
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Field, Input, Spinner } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { IdentityBadge } from './display';
import type { VisitorListItem } from './types';

export function VisitorPicker({
  label,
  description,
  value,
  onChange,
  excludeId,
  identifiedOnly,
  error,
}: {
  label: string;
  description?: string;
  value: VisitorListItem | null;
  onChange: (v: VisitorListItem | null) => void;
  excludeId?: string;
  identifiedOnly?: boolean;
  error?: string;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const name = useId();
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim().slice(0, 100)), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: ['visitor-search', q, !!identifiedOnly],
    queryFn: () =>
      api.page<VisitorListItem>('/visitors', {
        q,
        identified: identifiedOnly ? 'true' : undefined,
        limit: 8,
      }),
    enabled: q.length >= 2,
    staleTime: 10_000,
  });
  const items = (results.data?.items ?? []).filter((v) => v.id !== excludeId);

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} description={description} error={error}>
        <div className="relative">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-2"
            aria-hidden
          />
          <Input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('visitors.picker.placeholder')}
            className="ps-9"
            maxLength={100}
          />
        </div>
      </Field>
      <div aria-live="polite" className="text-sm">
        {q.length < 2 ? null : results.isLoading ? (
          <Spinner label={t('visitors.picker.searching')} />
        ) : results.isError ? (
          <p className="text-danger">
            {t('visitors.picker.searchFailed', { error: errorMessage(results.error) })}
          </p>
        ) : !items.length ? (
          <p className="text-fg-2">
            {identifiedOnly ? t('visitors.picker.noMatchesIdentified') : t('visitors.picker.noMatches')}
          </p>
        ) : (
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">{t('visitors.picker.resultsLegend')}</legend>
            {items.map((v) => {
              const id = `${name}-${v.id}`;
              return (
                <label
                  key={v.id}
                  htmlFor={id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line px-3 py-2 hover:bg-surface-2 has-[:checked]:border-primary has-[:checked]:bg-primary-tint"
                >
                  <input
                    id={id}
                    type="radio"
                    name={name}
                    checked={value?.id === v.id}
                    onChange={() => onChange(v)}
                    className="size-4 accent-[var(--primary)]"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-fg" dir="auto">
                      {v.displayName}
                    </span>
                    <span className="truncate text-xs text-fg-2">
                      {t('visitors.picker.resultMeta', {
                        who: isolate(v.email ?? v.anonymousLabel),
                        seen: formatRelative(v.lastSeenAt),
                        count: v.chatCount,
                      })}
                    </span>
                  </span>
                  <IdentityBadge
                    verified={v.identityVerified}
                    identified={!!v.email || v.displayName !== v.anonymousLabel}
                    compact
                  />
                </label>
              );
            })}
          </fieldset>
        )}
      </div>
    </div>
  );
}
