import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';

/** Text colour with WCAG AA contrast on a #rrggbb background (white or near-black). */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'var(--primary-fg)';
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Contrast with white = 1.05 / (L + 0.05); with #111 ≈ (L + 0.05) / 0.0569. Pick the larger.
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.0569 ? '#ffffff' : '#111111';
}

const sizes = { xs: 'size-6 text-[10px]', sm: 'size-8 text-xs', md: 'size-10 text-sm', lg: 'size-12 text-base' } as const;

/** Initials avatar; an optional image is decorative (the name is rendered nearby). */
export function Avatar({ name, src, color, size = 'sm', className }: { name: string; src?: string | null; color?: string | null; size?: keyof typeof sizes; className?: string }) {
  return (
    <span
      className={cn('relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold', sizes[size], className)}
      style={{ backgroundColor: color ?? 'var(--primary)', color: color ? readableOn(color) : 'var(--primary-fg)' }}
      aria-hidden
    >
      {src ? <img src={src} alt="" className="size-full object-cover" /> : initials(name)}
    </span>
  );
}
