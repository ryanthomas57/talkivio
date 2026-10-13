'use client';
import { useMemo } from 'react';
import { Combobox, type ComboOption } from './combobox';
import { useT } from '@/i18n';

function offsetLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** IANA timezone picker with current UTC offsets; values are IANA names. */
export function TimezonePicker({ value, onChange, disabled }: { value: string; onChange: (tz: string) => void; disabled?: boolean }) {
  const t = useT();
  const options = useMemo<ComboOption[]>(() => {
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
    const list = zones.includes('UTC') ? zones : ['UTC', ...zones];
    return list.map((z) => ({ value: z, label: z.replace(/_/g, ' '), hint: offsetLabel(z), keywords: [z.split('/').pop() ?? z] }));
  }, []);
  return <Combobox value={value} onChange={onChange} options={options} placeholder={t('ui.timezone.placeholder')} searchPlaceholder={t('ui.timezone.search')} disabled={disabled} />;
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
