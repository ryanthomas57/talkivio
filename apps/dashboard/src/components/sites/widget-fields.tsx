'use client';
import type { FieldRequirement } from '@talkivio/contracts';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Field, Input, Select, Textarea } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { contrast, formatRatio, HEX_RE, WIDGET_DARK_TEXT } from './widget-validation';

export function ColorField({
  label,
  description,
  value,
  onChange,
  error,
  disabled,
  children,
}: {
  label: string;
  description?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  const valid = HEX_RE.test(value);
  return (
    <div className="flex flex-col gap-1.5">
      <Field label={label} description={description} error={error}>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={t('sites.widget.colorPicker', { label })}
            value={valid ? value.toLowerCase() : '#000000'}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-1 disabled:cursor-not-allowed"
          />
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
            maxLength={7}
            className="w-32 font-mono uppercase"
            dir="ltr"
            spellCheck={false}
            disabled={disabled}
          />
        </div>
      </Field>
      {children}
    </div>
  );
}

/** Contrast of white and the widget's dark text on a background (WCAG AA 4.5:1 for body text). */
export function PrimaryContrast({ color }: { color: string }) {
  const t = useT();
  const white = contrast(color, '#FFFFFF');
  const dark = contrast(color, WIDGET_DARK_TEXT);
  if (white === null || dark === null) return null;
  const best = Math.max(white, dark);
  const uses = white >= dark ? 'white' : 'dark';
  const ok = best >= 4.5;
  return (
    <ContrastLine ok={ok}>
      {t('sites.widget.contrast.primary', { white: formatRatio(white), dark: formatRatio(dark), uses })}
      {!ok && <> {t('sites.widget.contrast.primaryLow', { ratio: formatRatio(4.5) })}</>}
    </ContrastLine>
  );
}

/** `what` is the translated name of the pair ("Header"). */
export function PairContrast({ bg, fg, what }: { bg: string; fg: string; what: string }) {
  const t = useT();
  const r = contrast(bg, fg);
  if (r === null) return null;
  const ok = r >= 4.5;
  return (
    <ContrastLine ok={ok}>
      {t('sites.widget.contrast.pair', { what, ratio: formatRatio(r) })}
      {!ok && <> {r < 3 ? t('sites.widget.contrast.pairAuto', { ratio: formatRatio(3) }) : t('sites.widget.contrast.pairLow', { ratio: formatRatio(4.5) })}</>}
    </ContrastLine>
  );
}

function ContrastLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p
      className={cn('flex items-start gap-1.5 text-xs', ok ? 'text-fg-2' : 'font-medium text-warning')}
      aria-live="polite"
    >
      {ok ? (
        <CheckCircle2 className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
      ) : (
        <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
      )}
      <span>{children}</span>
    </p>
  );
}

export function NumField({
  label,
  description,
  value,
  onChange,
  min,
  max,
  unit,
  error,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  unit?: string;
  error?: string;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <Field label={label} description={description ?? (unit ? t('sites.widget.rangeUnit', { min, max, unit }) : t('sites.widget.range', { min, max }))} error={error}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={Number.isFinite(value) ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
          className="w-28 tabular"
        />
        {unit && <span className="text-sm text-fg-2">{unit}</span>}
      </div>
    </Field>
  );
}

export function TextField({
  label,
  description,
  value,
  onChange,
  max,
  error,
  multiline,
  disabled,
  placeholder,
}: {
  label: string;
  description?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  max: number;
  error?: string;
  multiline?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const len = value.trim().length;
  return (
    <Field
      label={label}
      description={description}
      error={error}
      action={
        <span
          className={cn('text-xs tabular', len > max ? 'font-medium text-danger' : 'text-fg-2')}
          aria-hidden
        >
          {formatNumber(len)}/{formatNumber(max)}
        </span>
      }
    >
      {multiline ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={max + 50}
          disabled={disabled}
          placeholder={placeholder}
          dir="auto"
          className="min-h-20"
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={max + 20}
          disabled={disabled}
          placeholder={placeholder}
          dir="auto"
        />
      )}
    </Field>
  );
}

export function RequirementSelect({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: FieldRequirement;
  onChange: (v: FieldRequirement) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <Field label={label}>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value as FieldRequirement)}
        disabled={disabled}
      >
        <option value="hidden">{t('sites.widget.requirement.hidden')}</option>
        <option value="optional">{t('common.optional')}</option>
        <option value="required">{t('common.required')}</option>
      </Select>
    </Field>
  );
}

export function Group({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-4 border-t border-line-subtle pt-5 first:border-t-0 first:pt-0',
        className,
      )}
      aria-label={title}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="text-base font-semibold">{title}</h3>
        {description && <p className="text-xs text-fg-2">{description}</p>}
      </div>
      {children}
    </section>
  );
}
