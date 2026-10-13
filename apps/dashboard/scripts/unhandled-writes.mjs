#!/usr/bin/env node
/**
 * Error-handling gate (AUD-71-35): every write the dashboard sends (api.post/put/patch/delete, realtime.command)
 * must have its failure handled somewhere, so a failed action is never silent.
 *
 * From each write call the checker follows the promise outwards until it finds
 *   - a `try { … }` around it, or `.catch(…)` / `.then(ok, fail)` on the chain (also on a variable holding it);
 *   - an owner that reports errors itself: a React Query `queryFn`/`mutationFn` (error state rendered by the page),
 *     or a component prop / hook option whose repo implementation handles every call of it (ConfirmDialog's
 *     onConfirm, TagEditor's onSave, useDirtyGuard's onSave, …);
 * following functions the way they flow: a callback passed to another call (guard(() => …), useCallback(…)) is
 * checked where that call is; a named function, const or returned member is checked at every reference, resolved
 * by the TypeScript checker (symbols, not names), across files. A write that reaches the top is reported.
 * Usage: node scripts/unhandled-writes.mjs
 */
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const src = resolve(app, 'src');
const OWNERS = new Set(['queryFn', 'mutationFn']);

const cfgPath = ts.findConfigFile(app, ts.sys.fileExists, 'tsconfig.json');
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, app);
const program = ts.createProgram(cfg.fileNames, { ...cfg.options, noEmit: true });
const checker = program.getTypeChecker();
const sources = program
  .getSourceFiles()
  .filter(
    (f) =>
      f.fileName.startsWith(src) && !/\.(test|spec)\.tsx?$/.test(f.fileName) && !f.fileName.includes('/._'),
  );

const resolveSymbol = (s) => (s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
/** symbol → every identifier referring to it (imports resolved; a shorthand `{ x }` counts as a reference to x). */
const refs = new Map();
const addRef = (sym, id) => {
  if (!sym) return;
  if (!refs.has(sym)) refs.set(sym, []);
  refs.get(sym).push(id);
};
for (const sf of sources) {
  const visit = (n) => {
    if (ts.isIdentifier(n)) {
      addRef(resolveSymbol(checker.getSymbolAtLocation(n)), n);
      if (n.parent && ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n)
        addRef(checker.getShorthandAssignmentValueSymbol(n.parent), n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
const isDeclName = (id) =>
  (id.parent &&
    (ts.isImportSpecifier(id.parent) ||
      ts.isImportClause(id.parent) ||
      ts.isExportSpecifier(id.parent) ||
      ts.isNamespaceImport(id.parent))) ||
  (id.parent &&
    (ts.isVariableDeclaration(id.parent) ||
      ts.isFunctionDeclaration(id.parent) ||
      ts.isMethodDeclaration(id.parent) ||
      ts.isPropertySignature(id.parent) ||
      ts.isMethodSignature(id.parent) ||
      ts.isPropertyAssignment(id.parent) ||
      ts.isParameter(id.parent) ||
      ts.isBindingElement(id.parent)) &&
    id.parent.name === id);

/** Every use of the symbol declared at `nameNode` must be handled. A member of an object literal is also used
 * through the literal's declared type (a zustand store's `s.switchTenant` refers to the interface property). */
function followSymbol(nameNode, seen) {
  const syms = [resolveSymbol(checker.getSymbolAtLocation(nameNode))];
  const member = nameNode.parent;
  if (
    member &&
    (ts.isMethodDeclaration(member) ||
      ts.isPropertyAssignment(member) ||
      ts.isShorthandPropertyAssignment(member)) &&
    ts.isObjectLiteralExpression(member.parent)
  ) {
    const typed = checker.getContextualType(member.parent)?.getProperty(nameNode.getText());
    if (typed) syms.push(typed);
  }
  const fresh = syms.filter((x) => x && !seen.has(x));
  if (!fresh.length) return syms.some(Boolean);
  for (const x of fresh) seen.add(x);
  const uses = fresh.flatMap((x) => refs.get(x) ?? []).filter((id) => !isDeclName(id));
  return uses.length > 0 && uses.every((id) => handled(id, seen));
}

/** A value that is still a promise (has `then`), as opposed to an awaited result. */
const isThenable = (node) => !!checker.getTypeAtLocation(node).getProperty('then');

/** The repo's definition of the component/hook a JSX tag or call refers to. */
function definitionOf(nameNode) {
  const sym = resolveSymbol(checker.getSymbolAtLocation(nameNode));
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (!decl || !decl.getSourceFile().fileName.startsWith(src)) return null;
  if (ts.isFunctionDeclaration(decl)) return decl.body ?? null;
  if (ts.isVariableDeclaration(decl)) return decl.initializer ?? null;
  return null;
}

/** A function given to a repo component prop / hook option: every call (or pass-through) of it inside must be handled. */
function handledInside(ownerName, member, seen) {
  const body = definitionOf(ownerName);
  if (!body) return false;
  const key = `${body.getSourceFile().fileName}:${body.pos}#${member}`;
  if (seen.has(key)) return true;
  seen.add(key);
  const uses = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (
        (ts.isIdentifier(c) && c.text === member) ||
        (ts.isPropertyAccessExpression(c) && c.name.text === member)
      )
        uses.push(n);
    }
    if (ts.isIdentifier(n) && n.text === member && n.parent && ts.isJsxExpression(n.parent)) uses.push(n);
    ts.forEachChild(n, visit);
  };
  visit(body);
  return uses.length > 0 && uses.every((u) => handled(u, seen));
}

/** True when the promise (or function value) at `start` ends up handled. */
function handled(start, seen = new Set()) {
  let p = start;
  // True while following a function value (callback / what useCallback returns) rather than a promise result.
  let carryingFunction = ts.isIdentifier(start);
  while (p.parent) {
    const parent = p.parent;
    if (ts.isTryStatement(parent) && parent.tryBlock === p) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === p) {
      if (parent.name.text === 'catch') return true;
      if (
        parent.name.text === 'then' &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.arguments.length > 1
      )
        return true;
    }
    if (ts.isJsxAttribute(parent)) {
      const attr = parent.name.getText();
      const el = parent.parent?.parent;
      const tag = el && (ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el)) ? el.tagName : null;
      return !!tag && /^[A-Z]/.test(tag.getText()) && handledInside(tag, attr, seen);
    }
    if (
      (ts.isPropertyAssignment(parent) && parent.initializer === p) ||
      (ts.isShorthandPropertyAssignment(parent) && parent.name === p)
    ) {
      const key = parent.name.getText();
      if (OWNERS.has(key)) return true;
      const obj = parent.parent;
      const call = obj?.parent;
      // Option of a repo hook: useDirtyGuard(dirty, { onSave: … }).
      if (
        ts.isObjectLiteralExpression(obj) &&
        call &&
        ts.isCallExpression(call) &&
        call.arguments.includes(obj) &&
        ts.isIdentifier(call.expression) &&
        definitionOf(call.expression)
      ) {
        return handledInside(call.expression, key, seen);
      }
      // Member of a returned object / store: follow every reference to that member.
      return followSymbol(parent.name, seen);
    }
    if (ts.isFunctionLike(parent) && parent !== start) {
      const fn = parent;
      carryingFunction = true;
      if (fn.parent && ts.isCallExpression(fn.parent) && fn.parent.arguments.includes(fn)) {
        p = fn.parent; // guard(() => …), useCallback(…), withReauth(…)
        continue;
      }
      if ((ts.isMethodDeclaration(fn) || ts.isFunctionDeclaration(fn)) && fn.name)
        return followSymbol(fn.name, seen);
      if (fn.parent && ts.isVariableDeclaration(fn.parent)) return followSymbol(fn.parent.name, seen);
      p = fn;
      continue;
    }
    if (ts.isAwaitExpression(parent)) carryingFunction = false;
    if (ts.isVariableDeclaration(parent) && parent.initializer === p && ts.isIdentifier(parent.name)) {
      // const save = useCallback(…) → wherever save is used; const req = api.put(…) → wherever req is caught/awaited.
      if (carryingFunction || ts.isFunctionLike(p)) return followSymbol(parent.name, seen);
      if (isThenable(p)) {
        const sym = resolveSymbol(checker.getSymbolAtLocation(parent.name));
        return (refs.get(sym) ?? []).filter((id) => !isDeclName(id)).some((id) => handled(id, seen));
      }
    }
    p = parent;
  }
  return false;
}

const findings = [];
let writes = 0;
for (const sf of sources) {
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const obj = n.expression.expression.getText(sf);
      const m = n.expression.name.text;
      if (
        (obj === 'api' && ['post', 'put', 'patch', 'delete'].includes(m)) ||
        (obj === 'realtime' && m === 'command')
      ) {
        writes++;
        if (!handled(n))
          findings.push(
            `${relative(app, sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  ${obj}.${m}(…) — a failure would go unreported`,
          );
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
if (findings.length) {
  console.error(
    `✗ ${findings.length} of ${writes} writes have no error handling on any path:\n  ${findings.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(
  `✓ all ${writes} writes have their failures handled (try/catch, .catch, or an owner that reports them)`,
);
