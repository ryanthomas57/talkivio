import type { format as source } from '../en/format';

/** Arabic for 'format': same keys and variables as English (enforced by the type and src/i18n/catalog.test.ts). */
export const format: Record<keyof typeof source, string> = {
  'format.today': 'اليوم',
  'format.yesterday': 'أمس',
  'format.justNow': 'الآن',
  'format.duration.s': '{s} ث',
  'format.duration.ms': '{m} د {s} ث',
  'format.duration.hm': '{h} س {m} د',
  'format.duration.dh': '{d} ي {h} س',
  'format.durationLong.hours':
    '{n, plural, zero {# ساعة} one {ساعة واحدة} two {ساعتان} few {# ساعات} many {# ساعة} other {# ساعة}}',
  'format.durationLong.minutes':
    '{n, plural, zero {# دقيقة} one {دقيقة واحدة} two {دقيقتان} few {# دقائق} many {# دقيقة} other {# دقيقة}}',
  'format.durationLong.seconds':
    '{n, plural, zero {# ثانية} one {ثانية واحدة} two {ثانيتان} few {# ثوانٍ} many {# ثانية} other {# ثانية}}',
  'format.durationLong.joiner': ' و',
  'format.bytes.b': '{n} بايت',
  'format.bytes.kb': '{n} ك.ب',
  'format.bytes.mb': '{n} م.ب',
} satisfies Record<string, string>;
