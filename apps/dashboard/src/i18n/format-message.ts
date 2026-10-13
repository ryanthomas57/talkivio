/**
 * The ICU MessageFormat subset the dashboard catalogs use:
 *   {name}                                   — variable
 *   {count, plural, =0 {…} one {# chat} other {# chats}}   — plural (Intl.PluralRules: Arabic has zero/one/two/few/many/other)
 *   {kind, select, transfer {…} other {…}}   — select
 * `#` inside a plural branch is the locale-formatted number. A literal brace is written '{' (quoted).
 * Unknown variables render as an empty string; malformed patterns render the raw text (never throw in UI).
 */
export type MessageValues = Record<string, string | number | null | undefined>;

type Node = string | { arg: string; kind: 'simple' } | { arg: string; kind: 'plural' | 'select'; offset: number; branches: Record<string, Node[]> };

const cache = new Map<string, Node[]>();
const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function parse(src: string): Node[] {
  let i = 0;
  const parseUntil = (stopAtBrace: boolean): Node[] => {
    const out: Node[] = [];
    let text = '';
    while (i < src.length) {
      const c = src[i]!;
      if (c === "'" && (src[i + 1] === '{' || src[i + 1] === '}' || src[i + 1] === "'")) {
        text += src[i + 1];
        i += 2;
        if (src[i] === "'") i++;
        continue;
      }
      if (c === '}' && stopAtBrace) break;
      if (c === '{') {
        if (text) out.push(text);
        text = '';
        i++;
        out.push(parseArg());
        continue;
      }
      text += c;
      i++;
    }
    if (text) out.push(text);
    return out;
  };
  const ident = (): string => {
    const m = /^\s*([^\s,{}]+)\s*/.exec(src.slice(i));
    if (!m) throw new Error('identifier expected');
    i += m[0].length;
    return m[1]!;
  };
  const parseArg = (): Node => {
    const arg = ident();
    if (src[i] === '}') {
      i++;
      return { arg, kind: 'simple' };
    }
    if (src[i] !== ',') throw new Error('"," expected');
    i++;
    const kind = ident();
    if (kind !== 'plural' && kind !== 'select') throw new Error(`unsupported argument type ${kind}`);
    if (src[i] !== ',') throw new Error('"," expected');
    i++;
    let offset = 0;
    const branches: Record<string, Node[]> = {};
    for (;;) {
      const ws = /^\s*/.exec(src.slice(i))![0];
      i += ws.length;
      if (src[i] === '}') {
        i++;
        break;
      }
      const key = ident();
      if (key.startsWith('offset:')) {
        offset = Number(key.slice(7));
        continue;
      }
      if (src[i] !== '{') throw new Error('"{" expected');
      i++;
      branches[key] = parseUntil(true);
      if (src[i] !== '}') throw new Error('"}" expected');
      i++;
    }
    if (!branches.other) throw new Error('"other" branch required');
    return { arg, kind, offset, branches };
  };
  return parseUntil(false);
}

function render(nodes: Node[], values: MessageValues, locale: string, hash: number | null): string {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') {
      out += hash === null ? n : n.replace(/#/g, formatNumber(hash, locale));
      continue;
    }
    const v = values[n.arg];
    if (n.kind === 'simple') {
      out += v === null || v === undefined ? '' : typeof v === 'number' ? formatNumber(v, locale) : v;
      continue;
    }
    if (n.kind === 'select') {
      const branch = n.branches[String(v)] ?? n.branches.other!;
      out += render(branch, values, locale, hash);
      continue;
    }
    const num = typeof v === 'number' ? v : Number(v ?? 0);
    const exact = n.branches[`=${num}`];
    let rules = pluralRules.get(locale);
    if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)));
    const branch = exact ?? n.branches[rules.select(num - n.offset)] ?? n.branches.other!;
    out += render(branch, values, locale, num - n.offset);
  }
  return out;
}

export function formatNumber(n: number, locale: string): string {
  let f = numberFormats.get(locale);
  if (!f) numberFormats.set(locale, (f = new Intl.NumberFormat(locale)));
  return f.format(n);
}

export function formatMessage(pattern: string, values: MessageValues = {}, locale = 'en'): string {
  let nodes = cache.get(pattern);
  if (!nodes) {
    try {
      nodes = parse(pattern);
    } catch {
      nodes = [pattern];
    }
    cache.set(pattern, nodes);
  }
  return render(nodes, values, locale, null);
}

/** Throws on a malformed pattern (used by the catalog tests, never at runtime). */
export function assertValidPattern(pattern: string): void {
  parse(pattern);
}

/** Variable names a pattern uses (catalog tests: a translation must use the same variables as English). */
export function patternVariables(pattern: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (typeof n === 'string') continue;
      names.add(n.arg);
      if (n.kind !== 'simple') for (const b of Object.values(n.branches)) walk(b);
    }
  };
  walk(parse(pattern));
  return [...names].sort();
}
