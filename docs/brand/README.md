# Talkivio brand

The mark is a folded ribbon forming a "T": a teal face over a violet underside. The wordmark is set in a geometric
sans. Masters here are derived from the supplied logo concepts (2026-10-13). The icon is the colour layer of concept 5
combined with its own mask, so it is truly transparent. The wordmark is the concept's vector letterforms.

| File | Use |
| --- | --- |
| `talkivio-icon-master.png` | Transparent master of the mark, 784 × 1040. Derive raster sizes from this file. |
| `talkivio-mark-256.png` | Mark, 256 px tall (README, documents) |
| `talkivio-app-icon-512.png` | Square app icon with transparent padding (the dashboard serves the same file as `src/app/icon.png`) |
| `talkivio-wordmark.svg` | Vector wordmark, `fill="currentColor"`: near-black on light, `#fafafa` on dark |

The dashboard uses `apps/dashboard/src/components/brand.tsx`:
- `BrandMark`: the mark;
- `BrandWordmark`: the inline vector wordmark;
- `BrandLockup`: mark plus wordmark. With a white-label `NEXT_PUBLIC_BRAND_NAME` it falls back to plain text.

The browser icons are `src/app/icon.png` (512) and `src/app/apple-icon.png` (180, on `#0a0f1e`).

## Colour

Taken from the mark itself:

| Ribbon colour | Value |
| --- | --- |
| Teal highlight | `#90fcf7` |
| Teal light | `#37e5e7` |
| Teal (brand) | `#05b0bd` |
| Teal deep | `#036b7f` |
| Violet light | `#6a44c9` |
| Violet | `#3e2f93` |
| Indigo | `#21226b` |

Brand gradient (decorative only): `linear-gradient(135deg, #37e5e7 0%, #05b0bd 48%, #6a44c9 100%)`. It is used for
the sign-in hairline and glow and for the active-navigation indicator.

Interface tokens (`apps/dashboard/src/app/globals.css`, widget `apps/widget/src/frame/theme.ts` and `styles.css`):

| Token | Light | Dark | Notes |
| --- | --- | --- | --- |
| primary | `#07778a` | `#2fd0d6` | Light: white text 5.2:1. The mark's `#05b0bd` is only 2.6:1 with white, so solid fills use the deeper teal. |
| primary-hover | `#05606f` | `#62e2e6` | |
| primary-tint | `#e0f5f6` | `#0e3440` | Primary text on the tint ≥ 4.6:1 |
| accent | `#5b3fc4` | `#9b82f5` | Violet, ≥ 5.8:1 on surfaces |
| canvas / surface | `#f5f7fb` / `#ffffff` | `#0a0f1e` / `#11182b` | Indigo-tinted neutrals |
| text / secondary / subdued | `#121a2d` / `#475369` / `#5b6880` | `#e8ecf7` / `#b2bccf` / `#94a0b8` | 16.2 / 7.8 / 5.2:1 and 16.2 / 9.2 / ≥ 5.6:1 |
| widget header (default) | `#0a0f1e` | | The site's primary colour defaults to `#07778A` |

Status colours (danger, warning, success, note) are unchanged; information moved to an indigo blue (`#3b4fc2` /
`#9aa8f5`). Analytics series keep their colour-vision-validated categorical palette.

The axe scans in `apps/dashboard/e2e` check contrast on every route in light, dark and Arabic.
