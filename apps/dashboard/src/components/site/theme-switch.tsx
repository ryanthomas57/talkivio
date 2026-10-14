import { ThemeToggle } from '@/components/theme-toggle';

/** The light/dark switch in the website's colours (the labels stay English, like the rest of the site). */
export function SiteThemeToggle({ className }: { className?: string }) {
  return (
    <ThemeToggle
      labels={{ toLight: 'Switch to light mode', toDark: 'Switch to dark mode' }}
      className={`size-8 border-[var(--site-ghost-border)] text-[var(--site-nav)] hover:bg-transparent hover:text-[var(--site-teal)] ${className ?? ''}`}
    />
  );
}
