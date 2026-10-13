'use client';
/**
 * Small settings-area form helpers built on the UI kit: deep equality for dirty
 * tracking, numeric and chip inputs, a card save bar, and the version-conflict
 * banner. Kept local to settings (the shared UI kit is not edited).
 */
import { RotateCw, X } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Banner, Button, Input, useFieldControl } from '@/components/ui';
import { isolate, tStatic, useT, type MessageKey } from '@/i18n';
import { ApiError, errorMessage, isApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

/** Structural equality for plain JSON-ish values (NaN equals NaN). */
export function isEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => isEqual(x, b[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => isEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** camelCase path → the snake_case key the API uses in `field_errors`. */
export const snakePath = (path: string) =>
  path
    .split('.')
    .map((p) => p.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
    .join('.');

export type FieldErrors = Record<string, string[]>;

/** First error for a path (exact key, or any nested key such as list items). */
export function fieldError(errors: FieldErrors | null | undefined, path: string): string | undefined {
  if (!errors) return undefined;
  const key = snakePath(path);
  if (errors[key]?.length) return errors[key][0];
  const nested = Object.keys(errors).find((k) => k.startsWith(`${key}.`));
  return nested ? errors[nested][0] : undefined;
}

/** Outcome of a failed write, split into what the UI shows where. */
export interface WriteFailure {
  conflict: boolean;
  message: string | null;
  fieldErrors: FieldErrors;
}

export function describeFailure(e: unknown): WriteFailure {
  if (isApiError(e, 'VERSION_CONFLICT')) return { conflict: true, message: null, fieldErrors: {} };
  if (e instanceof ApiError) return { conflict: false, message: errorMessage(e), fieldErrors: e.fieldErrors ?? {} };
  return { conflict: false, message: errorMessage(e), fieldErrors: {} };
}

/** Integer input; an empty or partial entry is reported as NaN so validation can flag it. */
export function NumberInput({ value, onChange, min, max, disabled, suffix, className, ...rest }: { value: number; onChange: (v: number) => void; min?: number; max?: number; disabled?: boolean; suffix?: string; className?: string; 'aria-label'?: string }) {
  const field = useFieldControl();
  const describedBy = [field['aria-describedby'], suffix ? `${field.id}-suffix` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        {...rest}
        type="number"
        inputMode="numeric"
        step={1}
        min={min}
        max={max}
        disabled={disabled}
        aria-describedby={describedBy}
        value={Number.isFinite(value) ? String(value) : ''}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
        className="w-28 tabular"
      />
      {suffix && (
        <span id={field.id ? `${field.id}-suffix` : undefined} className="text-sm text-fg-2">
          {suffix}
        </span>
      )}
    </div>
  );
}

export type IntUnit = 'minutes' | 'seconds' | 'hours' | 'days' | 'mb' | 'perHour' | 'chats';

const RANGE_MESSAGE: Record<IntUnit | 'none', MessageKey> = {
  none: 'settings.form.range',
  minutes: 'settings.form.rangeMinutes',
  seconds: 'settings.form.rangeSeconds',
  hours: 'settings.form.rangeHours',
  days: 'settings.form.rangeDays',
  mb: 'settings.form.rangeMb',
  perHour: 'settings.form.rangePerHour',
  chats: 'settings.form.rangeChats',
};

/** Integer range check with a readable message (runs in validators, outside render). */
export function checkInt(v: number, min: number, max: number, unit?: IntUnit): string | null {
  if (!Number.isFinite(v) || !Number.isInteger(v)) return tStatic('settings.form.wholeNumber');
  if (v < min || v > max) return tStatic(RANGE_MESSAGE[unit ?? 'none'], { min: formatNumber(min), max: formatNumber(max) });
  return null;
}

/**
 * Editable list of short strings shown as removable chips. Enter or comma adds the
 * typed value; each chip has a labelled remove button. `validate` rejects an entry
 * before it is added and the message is announced inline. `listLabel` names the list
 * ("Current recipients") and `limitMessage` is the sentence shown when `max` is hit.
 */
export function ChipsInput({
  values,
  onChange,
  placeholder,
  disabled,
  max,
  validate,
  normalize = (s) => s.trim(),
  addLabel,
  listLabel,
  limitMessage,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  max?: number;
  validate?: (v: string, all: string[]) => string | null;
  normalize?: (s: string) => string;
  addLabel?: string;
  listLabel?: string;
  limitMessage?: string;
}) {
  const t = useT();
  const field = useFieldControl();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const hintId = useId();
  const full = max !== undefined && values.length >= max;

  const add = () => {
    const parts = text
      .split(/[,\s]+/)
      .map(normalize)
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...values];
    for (const p of parts) {
      if (next.includes(p)) {
        setProblem(t('settings.form.chipDuplicate', { value: isolate(p) }));
        return;
      }
      const err = validate?.(p, next) ?? null;
      if (err) {
        setProblem(err);
        return;
      }
      if (max !== undefined && next.length >= max) {
        setProblem(limitMessage ?? t('settings.form.chipsLimit', { count: max }));
        return;
      }
      next.push(p);
    }
    setProblem(null);
    setText('');
    onChange(next);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !text && values.length) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={listLabel ?? t('settings.form.chipsCurrent')}>
          {values.map((v) => (
            <li key={v} className="inline-flex h-11 max-w-full items-center gap-1 rounded-full border border-line bg-surface-2 ps-3 pe-0.5 text-sm sm:h-8 sm:pe-1">
              <span className="truncate font-mono text-[13px]" dir="ltr">{v}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(values.filter((x) => x !== v))}
                  className="inline-flex size-10 items-center justify-center rounded-full text-fg-2 hover:bg-surface-3 hover:text-fg sm:size-7"
                  aria-label={t('settings.form.chipRemove', { value: v })}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="flex gap-2">
          <Input
            {...field}
            value={text}
            disabled={full}
            placeholder={full ? t('settings.form.chipsLimitReached', { max: formatNumber(max) }) : placeholder}
            aria-describedby={[field['aria-describedby'], problem ? hintId : null].filter(Boolean).join(' ') || undefined}
            onChange={(e) => {
              setText(e.target.value);
              if (problem) setProblem(null);
            }}
            onKeyDown={onKey}
            onBlur={() => text.trim() && add()}
            className="min-w-0 flex-1"
          />
          <Button variant="secondary" onClick={add} disabled={full || !text.trim()}>
            {addLabel ?? t('common.add')}
          </Button>
        </div>
      )}
      {problem && (
        <p id={hintId} role="alert" className="text-xs font-medium text-danger">
          {problem}
        </p>
      )}
      {disabled && values.length === 0 && <p className="text-sm text-fg-2">{t('common.none')}</p>}
    </div>
  );
}

/** Card footer with Save / Discard for one independently saved card. */
export function SaveBar({ dirty, saving, onSave, onDiscard, disabled, label, note }: { dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void; disabled?: boolean; label?: string; note?: ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line-subtle px-4 py-3 sm:px-6">
      <p className="me-auto text-xs text-fg-2" aria-live="polite">
        {note ?? (dirty ? t('settings.form.unsaved') : '')}
      </p>
      <Button variant="ghost" onClick={onDiscard} disabled={!dirty || saving}>
        {t('settings.form.discard')}
      </Button>
      <Button variant="primary" onClick={onSave} loading={saving} disabled={!dirty || disabled}>
        {label ?? t('common.saveChanges')}
      </Button>
    </div>
  );
}

/**
 * VERSION_CONFLICT: someone else saved first. Never overwrite silently (conventions).
 * `message` is the whole explanation for this object (defaults to the generic settings sentence).
 */
export function ConflictBanner({ onReload, message, className }: { onReload: () => Promise<unknown> | void; message?: string; className?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Banner
      tone="warning"
      className={className}
      title={t('settings.form.conflictTitle')}
      action={
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onReload();
            } finally {
              setBusy(false);
            }
          }}
        >
          <RotateCw className="size-3.5" aria-hidden />
          {t('common.reload')}
        </Button>
      }
    >
      {message ?? t('settings.form.conflictBody')}
    </Banner>
  );
}
