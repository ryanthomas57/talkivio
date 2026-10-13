import { describe, expect, it } from 'vitest';
import { DEFAULT_WIDGET_CONFIG } from '@talkivio/contracts/protocol';
import { contrastRatio, hoverOf, parseHex, readableOn, themeVars, tintOf, TOKENS } from '../src/frame/theme';

describe('theme color math', () => {
  it('parses short and long hex colors', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('176B73')).toEqual([23, 107, 115]);
    expect(parseHex('not-a-color')).toBeNull();
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('picks a readable foreground for the primary color', () => {
    expect(readableOn('#07778A')).toBe('#FFFFFF');
    expect(readableOn('#FFE066')).toBe(TOKENS.text);
    expect(readableOn('#0B57D0')).toBe('#FFFFFF');
    expect(contrastRatio('#07778A', readableOn('#07778A'))).toBeGreaterThanOrEqual(4.5);
  });

  it('uses the exact contract tokens for the default brand color', () => {
    expect(tintOf('#07778A')).toBe(TOKENS.primaryTint);
    expect(hoverOf('#07778a')).toBe(TOKENS.primaryHover);
  });

  it('derives a light tint with readable dark text for custom colors', () => {
    const tint = tintOf('#7B4BB7');
    expect(contrastRatio(tint, TOKENS.text)).toBeGreaterThanOrEqual(7);
  });

  it('repairs unreadable header text colors', () => {
    const cfg = { ...DEFAULT_WIDGET_CONFIG, appearance: { ...DEFAULT_WIDGET_CONFIG.appearance, headerBackground: '#FFFFFF', headerTextColor: '#F0F0F0' } };
    const vars = themeVars(cfg, false);
    expect(vars['--rd-header-fg']).toBe(TOKENS.text);
  });

  it('falls back to the text color for focus rings when the brand color is too light', () => {
    const cfg = { ...DEFAULT_WIDGET_CONFIG, appearance: { ...DEFAULT_WIDGET_CONFIG.appearance, primaryColor: '#FFF3B0' } };
    expect(themeVars(cfg, false)['--rd-focus']).toBe(TOKENS.text);
  });
});

describe('secondary colour', () => {
  const withColors = (primaryColor: string, secondaryColor: string) => ({ ...DEFAULT_WIDGET_CONFIG, appearance: { ...DEFAULT_WIDGET_CONFIG.appearance, primaryColor, secondaryColor } });

  it('drives the visitor bubble / accent surface with a contrast-safe text colour', () => {
    const light = themeVars(withColors('#07778A', '#FFE8A3'), false);
    expect(light['--rd-tint']).toBe('#FFE8A3');
    expect(contrastRatio(light['--rd-tint'], light['--rd-on-tint'])).toBeGreaterThanOrEqual(4.5);
    const deep = themeVars(withColors('#07778A', '#1D3557'), false);
    expect(deep['--rd-on-tint']).toBe('#FFFFFF');
    expect(contrastRatio(deep['--rd-tint'], deep['--rd-tint-accent'])).toBeGreaterThanOrEqual(3);
  });

  it('falls back to a primary tint for an invalid secondary and in dark mode', () => {
    expect(themeVars(withColors('#07778A', 'nope'), false)['--rd-tint']).toBe(TOKENS.primaryTint);
    expect(themeVars(withColors('#07778A', '#FFE8A3'), true)['--rd-tint']).not.toBe('#FFE8A3');
  });
});
