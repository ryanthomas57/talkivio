'use client';
/**
 * Editable list of short strings (quick-reply options, tags). Enter or the Add
 * button appends; each chip has a labelled remove button. `check` can reject an
 * entry before it is added; the API still validates everything on save.
 */
import { X } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { Button, Input, useFieldControl } from '@/components/ui';
import { isolate, useT } from '@/i18n';

/** Translated copy for one kind of chip ("options", "tags"). */
export interface ChipLabels {
  list: string;
  remove: (value: string) => string;
  atMost: (max: number) => string;
}

export function ChipEditor({
  values,
  onChange,
  max,
  maxLength,
  placeholder,
  disabled,
  check,
  normalize = (s) => s.trim(),
  labels,
  listId,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  max: number;
  maxLength: number;
  placeholder?: string;
  disabled?: boolean;
  check?: (v: string) => string | null;
  normalize?: (s: string) => string;
  labels: ChipLabels;
  listId?: string;
}) {
  const t = useT();
  const field = useFieldControl();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const hintId = useId();
  const full = values.length >= max;

  const add = () => {
    const v = normalize(text);
    if (!v) return;
    if (values.includes(v)) return setProblem(t('shortcuts.chips.duplicate', { value: isolate(v) }));
    if ([...v].length > maxLength) return setProblem(t('shortcuts.chips.tooLong', { max: maxLength }));
    const err = check?.(v) ?? null;
    if (err) return setProblem(err);
    if (full) return setProblem(labels.atMost(max));
    setProblem(null);
    setText('');
    onChange([...values, v]);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={labels.list}>
          {values.map((v) => (
            <li key={v} className="inline-flex h-8 max-w-full items-center gap-1 rounded-full border border-line bg-surface-2 ps-3 pe-1 text-sm">
              <span className="truncate" dir="auto">{v}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(values.filter((x) => x !== v))}
                  className="inline-flex size-7 items-center justify-center rounded-full text-fg-2 hover:bg-surface-3 hover:text-fg"
                  aria-label={labels.remove(v)}
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
            list={listId}
            placeholder={full ? t('shortcuts.chips.limitReached', { max }) : placeholder}
            aria-describedby={[field['aria-describedby'], problem ? hintId : null].filter(Boolean).join(' ') || undefined}
            onChange={(e) => {
              setText(e.target.value);
              if (problem) setProblem(null);
            }}
            onKeyDown={onKey}
            className="min-w-0 flex-1"
          />
          <Button variant="secondary" onClick={add} disabled={full || !text.trim()}>
            {t('common.add')}
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
