/** Color math and CSS custom properties derived from the widget configuration. */
import type { WidgetConfig, WidgetFont } from '@talkivio/contracts/protocol';

export const TOKENS = {
  primary: '#07778A',
  primaryHover: '#05606F',
  primaryTint: '#E0F5F6',
  canvas: '#F5F7FB',
  surface: '#FFFFFF',
  text: '#121A2D',
  text2: '#475369',
  border: '#D8DEEA',
  danger: '#B42318',
} as const;

type RGB = [number, number, number];

export function parseHex(input: string | null | undefined): RGB | null {
  if (!input) return null;
  let h = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** WCAG relative luminance. */
export function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return 1;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Pick the more readable of a light and a dark foreground for the given background. */
export function readableOn(bg: string, light = '#FFFFFF', dark: string = TOKENS.text): string {
  return contrastRatio(bg, light) >= contrastRatio(bg, dark) ? light : dark;
}

export function mix(a: string, b: string, weight: number): string {
  const ca = parseHex(a) ?? [0, 0, 0];
  const cb = parseHex(b) ?? [0, 0, 0];
  return toHex([0, 1, 2].map((i) => ca[i] * (1 - weight) + cb[i] * weight) as RGB);
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

const same = (a: string, b: string) => a.trim().toUpperCase() === b.toUpperCase();

/** Light tint of the brand color used for the visitor's own bubbles (dark text on top). */
export function tintOf(primary: string): string {
  if (same(primary, TOKENS.primary)) return TOKENS.primaryTint;
  const rgb = parseHex(primary);
  if (!rgb) return TOKENS.primaryTint;
  const [h, s] = rgbToHsl(rgb);
  return toHex(hslToRgb(h, Math.min(0.45, s), 0.925));
}

/** Hover/pressed shade of the brand color. */
export function hoverOf(primary: string): string {
  if (same(primary, TOKENS.primary)) return TOKENS.primaryHover;
  const rgb = parseHex(primary);
  if (!rgb) return TOKENS.primaryHover;
  // Darken light colors, lighten very dark ones so the state change stays visible.
  return luminance(rgb) < 0.03 ? mix(primary, '#FFFFFF', 0.18) : mix(primary, '#000000', 0.24);
}

export function fontStack(font: WidgetFont): string {
  const system = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Noto Sans Arabic", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';
  switch (font) {
    case 'inter':
      return `Inter, "Inter var", ${system}`;
    case 'serif':
      return 'ui-serif, Georgia, Cambria, "Times New Roman", "Noto Naskh Arabic", serif';
    case 'rounded':
      return `ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Nunito, Quicksand, ${system}`;
    case 'mono':
      return 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
    default:
      return system;
  }
}

/** CSS custom properties for the root element. */
export function themeVars(config: WidgetConfig, dark: boolean): Record<string, string> {
  const a = config.appearance;
  const primary = parseHex(a.primaryColor) ? a.primaryColor : TOKENS.primary;
  const onPrimary = readableOn(primary);
  const surface = dark ? '#11182B' : TOKENS.surface;
  const text = dark ? '#E8ECF7' : TOKENS.text;
  const headerBg = parseHex(a.headerBackground) ? a.headerBackground : '#0A0F1E';
  let headerFg = parseHex(a.headerTextColor) ? a.headerTextColor : '#FFFFFF';
  if (contrastRatio(headerBg, headerFg) < 3) headerFg = readableOn(headerBg);
  // Brand-colored text/outline on the surface must stay legible; fall back to the text color.
  const accentText = contrastRatio(primary, surface) >= 4.5 ? primary : dark ? mix(primary, '#FFFFFF', 0.45) : text;
  const accentTextFinal = contrastRatio(accentText, surface) >= 4.5 ? accentText : text;
  const focus = contrastRatio(primary, surface) >= 3 ? primary : text;
  // Visitor bubbles + accent surfaces use the configured secondary colour (light mode). Dark mode keeps a
  // primary-derived tint because the secondary colour is designed as a light surface.
  const secondary = parseHex(a.secondaryColor) ? a.secondaryColor : null;
  const tint = dark ? mix(surface, primary, 0.32) : (secondary ?? tintOf(primary));
  const onTint = dark ? '#F3F7FA' : readableOn(tint);
  // Brand-coloured icons/labels placed on the tint must keep ≥ 3:1 (non-text) contrast.
  const tintAccent = contrastRatio(accentTextFinal, tint) >= 3 ? accentTextFinal : onTint;
  const vars: Record<string, string> = {
    '--rd-primary': primary,
    '--rd-primary-hover': hoverOf(primary),
    '--rd-on-primary': onPrimary,
    '--rd-accent-text': accentTextFinal,
    '--rd-focus': focus,
    '--rd-tint': tint,
    '--rd-on-tint': onTint,
    '--rd-tint-accent': tintAccent,
    '--rd-header-bg': headerBg,
    '--rd-header-fg': headerFg,
    '--rd-radius': `${clamp(a.borderRadius, 0, 28)}px`,
    '--rd-launcher-radius': `${clamp(a.buttonRadius, 0, 28)}px`,
    '--rd-btn-radius': `${clamp(Math.round(a.buttonRadius / 2.5), 6, 12)}px`,
    '--rd-font': fontStack(a.font),
  };
  return vars;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

export function isDarkTheme(config: WidgetConfig, prefersDark: boolean): boolean {
  const theme = config.appearance.theme;
  return theme === 'dark' || (theme === 'auto' && prefersDark);
}
