'use client';
/**
 * Small typed inputs for the trigger editor, built on the UI kit. They report raw
 * user intent (NaN for an empty number) and leave validity to the shared DSL
 * validator so the editor rejects exactly what the API rejects.
 */
import { X } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { Button, Input, useFieldControl } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';

/** Number input; an empty entry is NaN so the validator reports it. */
export function NumberBox({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  suffix,
  className,
  inputClassName,
  ...rest
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number | 'any';
  disabled?: boolean;
  suffix?: string;
  className?: string;
  inputClassName?: string;
  'aria-label'?: string;
  id?: string;
}) {
  const field = useFieldControl();
  const suffixId = useId();
  const describedBy = [field['aria-describedby'], suffix ? suffixId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        {...rest}
        type="number"
        inputMode={step === 1 ? 'numeric' : 'decimal'}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        aria-describedby={describedBy}
        value={Number.isFinite(value) ? String(value) : ''}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
        className={cn('w-32 tabular', inputClassName)}
      />
      {suffix && (
        <span id={suffixId} className="text-sm text-fg-2">
          {suffix}
        </span>
      )}
    </div>
  );
}

/**
 * Editable list of values (for `is any of` / `is none of`). Enter or the Add button
 * appends the typed value; each entry has a labelled remove button.
 */
export function ValueList({
  values,
  onChange,
  numeric,
  disabled,
  placeholder,
  max = 100,
  label,
}: {
  values: Array<string | number | boolean>;
  onChange: (v: Array<string | number>) => void;
  numeric?: boolean;
  disabled?: boolean;
  placeholder?: string;
  max?: number;
  label: string;
}) {
  const t = useT();
  const field = useFieldControl();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const hintId = useId();

  const add = () => {
    const raw = text.trim();
    if (!raw) return;
    const v: string | number = numeric ? Number(raw) : raw;
    if (numeric && !Number.isFinite(v as number)) {
      setProblem(t('triggers.input.enterNumber'));
      return;
    }
    if (values.some((x) => x === v)) {
      setProblem(t('triggers.input.duplicate', { value: isolate(raw) }));
      return;
    }
    if (values.length >= max) {
      setProblem(t('triggers.input.maxValues', { max }));
      return;
    }
    setProblem(null);
    setText('');
    onChange([...(values as Array<string | number>), v]);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {values.map((v, i) => (
            <li key={`${String(v)}-${i}`} className="inline-flex h-8 max-w-full items-center gap-1 rounded-full border border-line bg-surface-2 ps-3 pe-1 text-sm">
              <span className="truncate" dir="auto">
                {String(v)}
              </span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange((values as Array<string | number>).filter((_, j) => j !== i))}
                  className="inline-flex size-7 items-center justify-center rounded-full text-fg-2 hover:bg-surface-3 hover:text-fg"
                  aria-label={t('triggers.input.removeValue', { value: isolate(String(v)) })}
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
            inputMode={numeric ? 'decimal' : undefined}
            placeholder={placeholder ?? (numeric ? t('triggers.input.addNumber') : t('triggers.input.addValue'))}
            aria-describedby={[field['aria-describedby'], problem ? hintId : null].filter(Boolean).join(' ') || undefined}
            onChange={(e) => {
              setText(e.target.value);
              if (problem) setProblem(null);
            }}
            onKeyDown={onKey}
            dir="auto"
            className="min-w-0 flex-1"
          />
          <Button variant="secondary" onClick={add} disabled={!text.trim()}>
            {t('common.add')}
          </Button>
        </div>
      )}
      {problem && (
        <p id={hintId} role="alert" className="text-xs font-medium text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

/** Code-point counter shown beneath text areas ("120 / 2000"). */
export function CharCount({ value, max, id }: { value: string; max: number; id?: string }) {
  const n = [...value].length;
  return (
    <p id={id} className={cn('text-end text-xs tabular', n > max ? 'font-medium text-danger' : 'text-fg-2')} aria-live={n > max ? 'polite' : 'off'}>
      {formatNumber(n)} / {formatNumber(max)}
    </p>
  );
}

/** Inline list of validator messages for one row. */
export function IssueList({ messages, id }: { messages: string[]; id?: string }) {
  if (!messages.length) return null;
  return (
    <ul id={id} className="flex flex-col gap-1" role="alert">
      {messages.map((m, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs font-medium text-danger">
          <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-danger" />
          <span dir="auto">{m}</span>
        </li>
      ))}
    </ul>
  );
}
