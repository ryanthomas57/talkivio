#!/usr/bin/env node
/**
 * Lists hard-coded user-visible English in the dashboard (ch. 29: all copy is localizable), using the
 * TypeScript AST (not regexes):
 *   - JSX text with letters
 *   - string literals in UI attributes (aria-label, placeholder, title, label, description, alt, …)
 *   - string literals / templates passed to toast(), toast.success|error|info|warning|message()
 *   - string literals in object properties named like UI copy (label, title, description, placeholder, …)
 *   - string literals returned from functions whose name ends in Label/Text/Title/Message/Description
 * A line can opt out with a trailing `// i18n-ignore` (codes, CSS, brand names, sample data).
 *
 * Usage: node scripts/i18n-scan.mjs [path-prefix …] [--json] [--max N]
 *   exit 1 when findings exceed --max (default: report only).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const args = process.argv.slice(2);
const json = args.includes('--json');
const maxIdx = args.indexOf('--max');
const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : null;
const prefixes = args.filter((a, i) => !a.startsWith('--') && (maxIdx < 0 || i !== maxIdx + 1));

// i18n: the catalogs themselves; design-system: developer-only component stories (English, not served in production).
const SKIP_DIRS = new Set(['i18n', 'design-system']);
const SKIP_FILES = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /^\._/, /\.d\.ts$/];
const UI_ATTRS = new Set(['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'placeholder', 'title', 'label', 'description', 'alt', 'hint', 'help', 'emptyText', 'emptyTitle', 'emptyDescription', 'confirmLabel', 'cancelLabel', 'actionLabel', 'heading', 'subtitle', 'caption', 'tooltip', 'message', 'reason', 'loadingLabel']);
const UI_PROPS = new Set(['label', 'title', 'description', 'placeholder', 'hint', 'help', 'message', 'text', 'heading', 'subtitle', 'caption', 'tooltip', 'emptyTitle', 'emptyDescription', 'confirmLabel', 'actionLabel', 'summary', 'reason', 'error']);
const LETTERS = /[A-Za-z]{2,}/;

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(f)) walk(p);
    } else if (/\.tsx?$/.test(f) && !SKIP_FILES.some((r) => r.test(f))) files.push(p);
  }
};
walk(src);

const findings = [];
for (const file of files) {
  const rel = relative(root, file);
  if (prefixes.length && !prefixes.some((p) => rel.startsWith(p) || rel.startsWith(`src/${p}`))) continue;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const add = (node, kind, value) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (/i18n-ignore/.test(lines[line] ?? '')) return;
    const v = value.replace(/\s+/g, ' ').trim();
    if (!LETTERS.test(v) || /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(v)) return; // message keys are not copy
    findings.push({ file: rel, line: line + 1, kind, text: v.slice(0, 100) });
  };
  const literal = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => '…' + s.literal.text).join('') : null);
  // String literals an expression can evaluate to: a ? 'x' : 'y', a ?? 'x', cond && 'x', ('x'), `x${y}`.
  const outcomes = (n, kind) => {
    if (!n) return;
    if (ts.isParenthesizedExpression(n)) return outcomes(n.expression, kind);
    if (ts.isConditionalExpression(n)) return (outcomes(n.whenTrue, kind), outcomes(n.whenFalse, kind));
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(n.operatorToken.kind)) {
      if (n.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) outcomes(n.left, kind);
      return outcomes(n.right, kind);
    }
    const v = literal(n);
    if (v !== null) add(n, kind, v);
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) add(node, 'jsx-text', node.text);
    else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) outcomes(node.expression, 'jsx-expr');
    else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (UI_ATTRS.has(name)) {
        const init = node.initializer;
        if (ts.isStringLiteral(init)) add(node, `attr:${name}`, init.text);
        else if (ts.isJsxExpression(init)) outcomes(init.expression, `attr:${name}`);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (/^toast(\.(success|error|info|warning|message|loading))?$/.test(callee) || /^set\w*(Error|Errors|Notice|Message|FieldErr\w*)$/.test(callee)) {
        outcomes(node.arguments[0], `call:${callee}`);
      }
    } else if (ts.isPropertyAssignment(node)) {
      const v = literal(node.initializer);
      const prop = node.name.getText(sf).replace(/['"]/g, '');
      // UI-named properties, or any sentence-like value (lookup maps such as reason → label).
      if (v !== null && ((UI_PROPS.has(prop) && /[A-Z ]/.test(v)) || /^[A-Z][a-z]+( [A-Za-z'’,.:()-]+)+[.!?]?$/.test(v) || /^[A-Z][a-z]{2,}$/.test(v))) add(node, `prop:${prop}`, v);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // errors.email = 'Enter your email address'
      const v = literal(node.right);
      if (v !== null && /^[A-Z][a-z]+ [^]*[a-z]/.test(v)) add(node, `assign:${node.left.getText(sf)}`, v);
    } else if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && /^(title|description|label|message|text|heading|summary)$|(Label|Text|Title|Message|Description)$/.test(node.name.text)) {
      outcomes(node.initializer, `const:${node.name.text}`);
    } else if (ts.isBindingElement(node) && node.initializer) {
      // Default props: ({ placeholder = 'Select…', emptyText = 'No matches' })
      const name = node.name.getText(sf);
      if (UI_ATTRS.has(name) || UI_PROPS.has(name) || /(Label|Text|Placeholder|Title|Message)$/.test(name)) outcomes(node.initializer, `default:${name}`);
    } else if (ts.isReturnStatement(node) && node.expression) {
      let fn = node.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      const name = fn && fn.name ? fn.name.getText(sf) : '';
      if (/(Label|Text|Title|Message|Description|label|text)$/.test(name)) outcomes(node.expression, `return:${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (json) console.log(JSON.stringify(findings, null, 2));
else {
  const byFile = new Map();
  for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  for (const [file, list] of [...byFile.entries()].sort()) {
    console.log(`${file} (${list.length})`);
    for (const f of list) console.log(`  ${f.line}  ${f.kind}  ${f.text}`);
  }
  console.log(`\n${findings.length} hard-coded strings in ${byFile.size} files${prefixes.length ? ` under ${prefixes.join(', ')}` : ''}`);
}
if (max !== null && findings.length > max) process.exit(1);
