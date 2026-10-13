import { describe, expect, it } from 'vitest';
import { WIDGET_LANGUAGES } from '@talkivio/contracts/protocol';
import { isRtl, LOCALES, missingKeys, resolveLocale, t, tp, translator } from '../src/frame/i18n';

describe('locale resolution', () => {
  it('follows SDK → site → browser → en precedence', () => {
    expect(resolveLocale('ar', 'fr', 'de-DE').locale).toBe('ar');
    expect(resolveLocale(null, 'fr', 'de-DE').locale).toBe('fr');
    expect(resolveLocale(null, 'auto', 'pt-BR').locale).toBe('pt');
    expect(resolveLocale(null, 'auto', 'ja-JP').locale).toBe('ja');
    expect(resolveLocale(null, 'auto', 'ko-KR').locale).toBe('en');
  });

  it('falls back deterministically and reports unsupported explicit locales', () => {
    expect(resolveLocale('sv-SE', 'es', 'en')).toEqual({ locale: 'es', unsupported: 'sv-SE' });
    expect(resolveLocale('it-IT', 'es', 'en')).toEqual({ locale: 'it', unsupported: null });
    expect(resolveLocale('xx', 'ja', null)).toEqual({ locale: 'ja', unsupported: 'xx' });
    expect(resolveLocale('xx', 'ko', null)).toEqual({ locale: 'en', unsupported: 'xx' });
    expect(resolveLocale(null, 'sv', 'ar-EG')).toEqual({ locale: 'ar', unsupported: 'sv' });
  });

  it('marks Arabic as right-to-left', () => {
    expect(isRtl('ar')).toBe(true);
    expect(translator('ar').rtl).toBe(true);
    expect(translator('en').rtl).toBe(false);
  });
});

describe('translations', () => {
  it('interpolates variables', () => {
    expect(t('en', 'powered_by', { brand: 'Talkivio' })).toBe('Powered by Talkivio');
    expect(t('fr', 'typing', { name: 'Alex' })).toBe('Alex est en train d’écrire…');
  });

  it('uses Intl plural rules (including Arabic dual / few / many)', () => {
    expect(tp('en', 'unread', 1)).toBe('1 unread message');
    expect(tp('en', 'unread', 3)).toBe('3 unread messages');
    expect(tp('ar', 'unread', 2)).toBe('رسالتان غير مقروءتين');
    expect(tp('ar', 'queue_ahead', 1)).toBe('أمامك شخص واحد تقريبًا');
  });

  it('translates chrome strings in every locale (no silent English fallback)', () => {
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      for (const key of ['open_chat', 'start_chat', 'reconnecting', 'rating_good', 'new_chat', 'queue_label'] as const) {
        expect(t(locale, key)).not.toBe(t('en', key));
      }
    }
  });
});

describe('catalogue coverage', () => {
  it('covers every selectable widget language with a complete catalogue', () => {
    for (const lang of WIDGET_LANGUAGES) if (lang !== 'auto') expect(LOCALES as readonly string[]).toContain(lang);
    for (const locale of LOCALES) expect(missingKeys(locale)).toEqual([]);
  });

  it('uses each language plural rules and number formatting', () => {
    expect(tp('it', 'unread', 1)).toBe('1 messaggio non letto');
    expect(tp('it', 'unread', 3)).toBe('3 messaggi non letti');
    expect(tp('nl', 'queue_ahead', 1)).toBe('Ongeveer 1 persoon voor je');
    expect(tp('nl', 'queue_ahead', 2)).toBe('Ongeveer 2 personen voor je');
    expect(tp('ja', 'unread', 1)).toBe('未読メッセージ1件');
    expect(tp('it', 'unread', 12000)).toBe('12.000 messaggi non letti');
  });
});
