/**
 * Shortcuts (canned responses). Agents type `/name` (or `#name`) in the composer to expand.
 * Messages may contain placeholders such as {{visitor.name}} and may offer
 * quick-reply options that the visitor can tap.
 */

export const SHORTCUT_PLACEHOLDERS = [
  { key: 'visitor.name', label: 'Visitor name' },
  { key: 'visitor.first_name', label: 'Visitor first name' },
  { key: 'visitor.email', label: 'Visitor email' },
  { key: 'agent.name', label: 'Your display name' },
  { key: 'agent.first_name', label: 'Your first name' },
  { key: 'department.name', label: 'Department name' },
  { key: 'website.name', label: 'Website name' },
  { key: 'page.url', label: 'Current page URL' },
] as const;

export type PlaceholderValues = Partial<Record<(typeof SHORTCUT_PLACEHOLDERS)[number]['key'], string | null | undefined>>;

export function renderPlaceholders(template: string, values: PlaceholderValues): string {
  return template.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (_m, key: string) => {
    // Accept both {{visitor.name}} and the classic {{visitor_name}} spelling.
    const k = key.toLowerCase().replace(/^(visitor|agent|department|website|page)_/, '$1.') as keyof PlaceholderValues;
    const v = values[k];
    return v === null || v === undefined ? '' : String(v);
  });
}

/** Shortcut names: lowercase letters, digits, dashes and underscores. */
export const SHORTCUT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Find an in-progress `/query` or `#query` token at the caret position of a composer value. */
export function findShortcutQuery(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const m = /(^|\s)[/#]([a-z0-9_-]*)$/i.exec(before);
  if (!m) return null;
  return { query: m[2].toLowerCase(), start: caret - m[2].length - 1 };
}
