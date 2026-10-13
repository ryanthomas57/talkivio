import { describe, expect, it } from 'vitest';
import { assertValidPattern, formatMessage, patternVariables } from './format-message';
import { acceptLanguageTags, negotiateLocale } from './locales';
import { AREAS as AR } from './messages/ar';
import { AREAS as EN } from './messages/en';

describe('format-message', () => {
  it('interpolates, pluralises (Arabic categories) and selects', () => {
    expect(formatMessage('Hi {name}', { name: 'Sam' })).toBe('Hi Sam');
    const p = '{n, plural, =0 {no chats} one {# chat} other {# chats}}';
    expect([0, 1, 2, 1200].map((n) => formatMessage(p, { n }, 'en'))).toEqual(['no chats', '1 chat', '2 chats', '1,200 chats']);
    const ar = '{n, plural, zero {لا محادثات} one {محادثة واحدة} two {محادثتان} few {# محادثات} many {# محادثة} other {# محادثة}}';
    expect(formatMessage(ar, { n: 2 }, 'ar')).toBe('محادثتان');
    expect(formatMessage(ar, { n: 3 }, 'ar')).toBe(`${new Intl.NumberFormat('ar').format(3)} محادثات`);
    expect(formatMessage('{k, select, transfer {Transfer} other {New chat}}', { k: 'transfer' })).toBe('Transfer');
    expect(formatMessage("Use '{'braces'}'")).toBe('Use {braces}');
    expect(formatMessage('{broken')).toBe('{broken');
  });

  it('negotiates locales', () => {
    expect(negotiateLocale(acceptLanguageTags('fr-FR,ar-AE;q=0.9,en;q=0.8'))).toBe('ar');
    expect(negotiateLocale(acceptLanguageTags('de'))).toBe('en');
    expect(negotiateLocale([])).toBe('en');
  });
});

describe('catalogs', () => {
  for (const [area, en] of Object.entries(EN) as Array<[string, Record<string, string>]>) {
    const ar = (AR as Record<string, Record<string, string>>)[area]!;
    describe(area, () => {
      it(`keys are prefixed '${area}.'`, () => {
        expect(Object.keys(en).filter((k) => !k.startsWith(`${area}.`))).toEqual([]);
      });
      it('Arabic has exactly the English keys', () => {
        expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
      });
      it('every pattern parses and uses the same variables in both languages', () => {
        const bad: string[] = [];
        for (const [k, v] of Object.entries(en)) {
          try {
            assertValidPattern(v);
            assertValidPattern(ar[k] ?? '');
            if (patternVariables(v).join() !== patternVariables(ar[k] ?? '').join()) bad.push(`${k}: ${patternVariables(v)} ≠ ${patternVariables(ar[k] ?? '')}`);
          } catch (e) {
            bad.push(`${k}: ${(e as Error).message}`);
          }
          if (v === '' || !ar[k]) bad.push(`${k}: empty`);
        }
        expect(bad).toEqual([]);
      });
      it('Arabic is translated (identical copy only for names, codes and formats)', () => {
        const same = Object.keys(en).filter((k) => ar[k] === en[k] && /[a-z]{3,}/.test(en[k]!.replace(/\{[^}]*\}/g, '')));
        expect(same).toEqual([]);
      });
    });
  }
});
