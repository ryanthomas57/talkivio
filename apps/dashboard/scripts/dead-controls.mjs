#!/usr/bin/env node
/**
 * Dead-control gate (AUD-71-35): every visible action in the dashboard and the widget must be wired to behaviour.
 * Parses each .tsx file with the TypeScript compiler and reports
 *   - buttons / menu items with no action: no onClick/onSelect/onPointerDown/onMouseDown, not a submit/reset button,
 *     not rendered through `asChild` and without a props spread that could carry the handler;
 *   - controls that are disabled unconditionally (a literal `disabled`) — visible but never usable;
 * A control rendered as the child of an `asChild` primitive (a Radix menu/dialog/popover trigger or close) gets its
 * behaviour from that parent. `data-demo` marks a deliberately inert sample in the component gallery.
 *   - links without a real destination: no href, href="#" or an empty href, and <a> used as a button.
 * Usage: node scripts/dead-controls.mjs [root …]   (defaults to the dashboard and widget sources)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const roots = process.argv.slice(2).length
  ? process.argv.slice(2).map((r) => resolve(r))
  : [resolve(here, '../src'), resolve(repo, 'apps/widget/src')];

const BUTTONS = new Set(['button', 'Button', 'MenuItem']);
const LINKS = new Set(['a', 'Link']);
const ACTIONS = ['onClick', 'onSelect', 'onPointerDown', 'onMouseDown'];

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._') || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const findings = [];
let checked = 0;
for (const file of roots.flatMap(files)) {
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(sf);
      if (BUTTONS.has(tag) || LINKS.has(tag)) {
        checked++;
        const attrs = new Map();
        let spread = false;
        for (const a of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(a)) spread = true;
          else attrs.set(a.name.getText(sf), a.initializer);
        }
        const literal = (name) => {
          const init = attrs.get(name);
          if (!init) return attrs.has(name) ? true : undefined; // bare attribute = true
          if (ts.isStringLiteral(init)) return init.text;
          if (
            ts.isJsxExpression(init) &&
            init.expression &&
            (init.expression.kind === ts.SyntaxKind.TrueKeyword ||
              init.expression.kind === ts.SyntaxKind.FalseKeyword)
          )
            return init.expression.kind === ts.SyntaxKind.TrueKeyword;
          if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression))
            return init.expression.text;
          return null; // dynamic
        };
        const where = `${relative(repo, file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
        // <Trigger asChild><Button/></Trigger>: the parent element supplies the handler.
        const element = ts.isJsxOpeningElement(node) ? node.parent : node;
        const parent =
          element.parent && ts.isJsxElement(element.parent) ? element.parent.openingElement : null;
        const viaParent =
          !!parent &&
          parent.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'asChild');
        if (attrs.has('data-demo')) {
          ts.forEachChild(node, visit);
          return;
        }
        if (BUTTONS.has(tag)) {
          const type = literal('type');
          const acts =
            ACTIONS.some((a) => attrs.has(a)) ||
            attrs.has('asChild') ||
            viaParent ||
            type === 'submit' ||
            type === 'reset' ||
            type === null ||
            spread ||
            attrs.has('form');
          if (!acts) findings.push(`${where}  <${tag}> has no action (no handler, not a submit button)`);
          if (literal('disabled') === true) findings.push(`${where}  <${tag}> is always disabled`);
        } else {
          const href = literal('href');
          if (!attrs.has('href') && !spread)
            findings.push(
              `${where}  <${tag}> has no href${attrs.has('onClick') ? ' (a link used as a button)' : ''}`,
            );
          else if (href === '#' || href === '')
            findings.push(`${where}  <${tag}> href="${href}" goes nowhere`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (findings.length) {
  console.error(
    `✗ ${findings.length} control(s) without behaviour (of ${checked} checked):\n  ${findings.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`✓ ${checked} buttons, menu items and links all have an action or a destination`);
