'use client';
/**
 * Searchable single/multi select (cmdk inside a Radix popover). The trigger is a
 * native button with the field's accessible name; the list supports arrows,
 * Enter and Escape, and typeahead filtering.
 */
import * as Popover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';
import { useFieldControl } from './field';
import { controlClass } from './input';

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
  keywords?: string[];
  disabled?: boolean;
}

interface BaseProps {
  options: ComboOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  footer?: ReactNode;
}

export function Combobox({ value, onChange, options, placeholder: placeholderProp, searchPlaceholder: searchProp, emptyText: emptyProp, disabled, className, footer }: BaseProps & { value: string | null; onChange: (v: string) => void }) {
  const t = useT();
  const placeholder = placeholderProp ?? t('ui.combobox.placeholder');
  const searchPlaceholder = searchProp ?? t('ui.combobox.search');
  const emptyText = emptyProp ?? t('ui.combobox.empty');
  const [open, setOpen] = useState(false);
  const field = useFieldControl();
  const selected = options.find((o) => o.value === value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button type="button" {...field} role="combobox" aria-expanded={open} className={cn(controlClass, 'flex h-10 items-center justify-between gap-2 text-left', className)}>
          <span className={cn('truncate', !selected && 'text-fg-3')}>{selected ? selected.label : placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-fg-2" aria-hidden />
        </button>
      </Popover.Trigger>
      <ComboList
        options={options}
        isSelected={(v) => v === value}
        onSelect={(v) => {
          onChange(v);
          setOpen(false);
        }}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
        footer={footer}
      />
    </Popover.Root>
  );
}

export function MultiCombobox({ values, onChange, options, placeholder: placeholderProp, searchPlaceholder: searchProp, emptyText: emptyProp, disabled, className, footer }: BaseProps & { values: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  const placeholder = placeholderProp ?? t('ui.combobox.placeholder');
  const searchPlaceholder = searchProp ?? t('ui.combobox.search');
  const emptyText = emptyProp ?? t('ui.combobox.empty');
  const [open, setOpen] = useState(false);
  const field = useFieldControl();
  const labels = options.filter((o) => values.includes(o.value)).map((o) => o.label);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button type="button" {...field} role="combobox" aria-expanded={open} className={cn(controlClass, 'flex min-h-10 items-center justify-between gap-2 py-2 text-left', className)}>
          <span className={cn('line-clamp-2', !labels.length && 'text-fg-3')}>{labels.length ? labels.join(', ') : placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-fg-2" aria-hidden />
        </button>
      </Popover.Trigger>
      <ComboList
        multi
        options={options}
        isSelected={(v) => values.includes(v)}
        onSelect={(v) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
        footer={footer}
      />
    </Popover.Root>
  );
}

function ComboList({ options, isSelected, onSelect, searchPlaceholder, emptyText, footer, multi }: { options: ComboOption[]; isSelected: (v: string) => boolean; onSelect: (v: string) => void; searchPlaceholder: string; emptyText: string; footer?: ReactNode; multi?: boolean }) {
  return (
    <Popover.Portal>
      <Popover.Content align="start" sideOffset={6} collisionPadding={8} className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[240px] rounded-[var(--radius-control)] border border-line bg-surface shadow-[var(--shadow-float)] data-[state=open]:animate-fade-in">
        <Command loop className="flex max-h-[320px] flex-col">
          <Command.Input placeholder={searchPlaceholder} className="h-10 w-full border-b border-line-subtle bg-transparent px-3 text-sm outline-none placeholder:text-fg-3" />
          <Command.List className="min-h-0 flex-1 overflow-y-auto p-2 scroll-thin" aria-multiselectable={multi || undefined}>
            <Command.Empty className="px-2 py-6 text-center text-sm text-fg-2">{emptyText}</Command.Empty>
            {options.map((o) => (
              <Command.Item
                key={o.value}
                value={`${o.label} ${o.value}`}
                keywords={o.keywords}
                disabled={o.disabled}
                onSelect={() => onSelect(o.value)}
                className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm text-fg data-[disabled=true]:cursor-not-allowed data-[disabled=true]:text-fg-3 data-[selected=true]:bg-surface-3"
              >
                <Check className={cn('size-4 shrink-0 text-primary', !isSelected(o.value) && 'invisible')} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="shrink-0 text-xs text-fg-2">{o.hint}</span>}
              </Command.Item>
            ))}
          </Command.List>
          {footer && <div className="border-t border-line-subtle p-2">{footer}</div>}
        </Command>
      </Popover.Content>
    </Popover.Portal>
  );
}
