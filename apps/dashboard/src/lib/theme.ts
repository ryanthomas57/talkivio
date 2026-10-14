/**
 * Light and dark mode. One choice covers the website, the sign-in pages and the dashboard: it is kept in this
 * browser (so the right colours paint before any script loads) and, for signed-in members, in their preferences
 * (so it follows them to other browsers). With no choice yet, the website opens dark and the dashboard light.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_KEY = 'tk_theme';
/** Fired on window when the stored choice changes in this tab. */
export const THEME_EVENT = 'tk-theme';

/** The public website ("/" and the legal pages), which is designed dark first. */
export const isSiteRoute = (path: string | null | undefined): boolean =>
  path === '/' || !!path?.startsWith('/legal/');

export function storedTheme(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

export function rememberTheme(choice: ThemeChoice): void {
  try {
    if (localStorage.getItem(THEME_KEY) === choice) return;
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* storage unavailable (private mode): the choice still applies to this page */
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function resolveDark(choice: ThemeChoice): boolean {
  return (
    choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

/**
 * Runs in <head> before the first paint: applies the stored choice (or the route's default) so a dark page never
 * flashes light. Kept in step with isSiteRoute and resolveDark above.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_KEY}');var p=location.pathname;var s=p==='/'||p.indexOf('/legal/')===0;var d=c==='dark'||(c==='system'&&matchMedia('(prefers-color-scheme: dark)').matches)||(!c&&s);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;
