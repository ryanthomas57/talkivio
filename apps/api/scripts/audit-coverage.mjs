#!/usr/bin/env node
/**
 * Audit coverage gate (AUD-72-16, ch. 54): every write route (POST/PUT/PATCH/DELETE) of the API either records an
 * audit event on success or is listed below as not needing one, with the reason. A route counts as audited when
 * its handler — following calls into the services it uses, resolved by the TypeScript checker — reaches
 * AuditService.inTx / log / system. The exemptions are conversation and visitor data (messages, typing, uploads,
 * ratings …: the transcript is their record, and ch. 54 forbids copying full chat text into audit), self-service
 * session plumbing, and read-only computations sent as POST. Anything else must audit, so a new settings write that
 * forgets to is caught here — "invoking settings write directly through API without UI still emits the same audit".
 * Usage: node scripts/audit-coverage.mjs [--list]
 */
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const src = resolve(app, 'src');
const LIST = process.argv.includes('--list');

/** Write routes that need no audit event, by "METHOD /path" pattern (`*` = one segment, `**` = rest). */
const EXEMPT = [
  // Conversation data: the transcript, receipts and ratings are the record (ch. 54: no full chat text in audit).
  ['POST /chats/*/messages', 'chat message (transcript is the record)'],
  ['PUT /chats/*/read-cursor', 'read receipt'],
  ['POST /chats/*/accept', 'routine assignment (routing state + assignment events)'],
  ['POST /offers/*/decline', 'routine offer decline (assignment events)'],
  ['POST /chats/*/collaborators', 'participant change (participant events in the transcript)'],
  ['DELETE /chats/*/collaborators/*', 'participant change (participant events in the transcript)'],
  ['POST /chats/*/close', 'chat lifecycle (closed event and transcript)'],
  ['POST /shortcuts/*/render', 'read-only rendering of a reply'],
  ['POST /shortcuts/render-preview', 'read-only rendering of a draft reply'],
  ['POST /shortcuts/import-preview', 'read-only validation of an import file (the import itself is audited)'],
  [
    'POST /integrations/connectors/*/health-check',
    'connectivity probe; denied attempts are recorded by AuditedRequire',
  ],
  ['POST /attachments/uploads', 'upload lifecycle (attachment rows and scan state are the record)'],
  ['PUT /attachments/*/content', 'upload body'],
  ['POST /attachments/*/finalize', 'upload lifecycle'],
  ['DELETE /attachments/*', 'cancelling an unsent upload'],
  ['POST /widget/**', 'visitor action through the widget (visitor data, not administration)'],
  ['PUT /widget/**', 'visitor action through the widget'],
  ['DELETE /widget/**', 'visitor action through the widget'],
  // Session plumbing for the signed-in user (security events — login failures, MFA, resets — are audited).
  ['POST /socket-ticket', 'short-lived realtime ticket'],
  ['POST /tenants/switch', 'switches the active workspace of the caller’s own session'],
  ['PATCH /auth/profile', 'the caller’s own display name and avatar (messages keep their sender snapshot)'],
  ['POST /auth/verify-email', 'confirms the caller’s own address (users.email_verified_at is the record)'],
  ['POST /auth/verify-email/resend', 're-sends the verification email (rate limited)'],
  ['POST /auth/mfa/enroll', 'starts an enrollment; nothing changes until mfa/confirm, which is audited'],
  [
    'PATCH /tenants/current/onboarding',
    'onboarding checklist progress (each setting it leads to is audited where it is saved)',
  ],
  ['POST /chats/*/request-rating', 'asks the visitor for a rating (a system message in the transcript)'],
  ['POST /auth/logout', 'ends the caller’s own session'],
  ['PUT /agents/me/presence', 'presence (availability intervals are the record)'],
  ['PATCH /agents/me/preferences', 'personal UI preferences'],
  ['POST /notifications/**', 'marking notifications read'],
  // Billing: opening the gateway's hosted card form writes nothing (saving the card and every charge are audited).
  ['POST /billing/card-session', 'opens the payment form; nothing is stored'],
  // Read-only computations sent as POST.
  ['POST /exports/preview', 'preview count, nothing created'],
  ['POST /triggers/*/simulate', 'simulation, nothing changes'],
  // Collaboration on drafts: the publish step is audited.
  ['PUT /sites/*/widget-config', 'saving a draft (publish is audited)'],
  ['DELETE /sites/*/widget-config/draft', 'discarding a draft'],
  ['PUT /triggers/*/draft', 'saving a draft (publish is audited)'],
];
const toRe = (pattern) =>
  new RegExp(
    `^${pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]+')
      .replace(/\u0000/g, '.*')}$`,
  );
const exemptions = EXEMPT.map(([p, why]) => ({ re: toRe(p), p, why, used: false }));

const cfg = ts.parseJsonConfigFileContent(
  ts.readConfigFile(resolve(app, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  app,
);
const program = ts.createProgram(cfg.fileNames, { ...cfg.options, noEmit: true });
const checker = program.getTypeChecker();
const sources = program
  .getSourceFiles()
  .filter(
    (f) => f.fileName.startsWith(src) && !f.fileName.endsWith('.spec.ts') && !f.fileName.includes('/._'),
  );

const decorators = (node) => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []);
const decoratorCall = (d) => (ts.isCallExpression(d.expression) ? d.expression : null);
const decoName = (d) => decoratorCall(d)?.expression.getText() ?? d.expression.getText();
const decoArg = (d) => {
  const a = decoratorCall(d)?.arguments[0];
  return a && ts.isStringLiteral(a) ? a.text : '';
};
const join = (...parts) =>
  `/${parts.filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

const AUDIT_METHODS = new Set(['inTx', 'log', 'system']);
const memo = new Map();
/** Does this function body (or anything it calls in the repo, a few levels deep) write an audit event? */
function reachesAudit(fn, depth = 0, seen = new Set()) {
  if (!fn || !fn.body || depth > 6 || seen.has(fn)) return false;
  if (memo.has(fn)) return memo.get(fn);
  seen.add(fn);
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const target = n.expression.expression.getText();
      const direct = /(^|\.)auditEvent$/.test(target) && /^create(Many)?$/.test(n.expression.name.text);
      if (direct || (AUDIT_METHODS.has(n.expression.name.text) && /(^|\.)audit$/i.test(target))) {
        found = true;
        return;
      }
    }
    if (ts.isCallExpression(n)) {
      const sym = checker.getSymbolAtLocation(
        ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression,
      );
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
      if (
        decl &&
        decl.getSourceFile().fileName.startsWith(src) &&
        (ts.isMethodDeclaration(decl) ||
          ts.isFunctionDeclaration(decl) ||
          (ts.isPropertyDeclaration(decl) && decl.initializer && ts.isArrowFunction(decl.initializer)))
      ) {
        const target = ts.isPropertyDeclaration(decl) ? decl.initializer : decl;
        if (reachesAudit(target, depth + 1, seen)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  memo.set(fn, found);
  return found;
}

const routes = [];
for (const sf of sources) {
  ts.forEachChild(sf, function visitTop(node) {
    if (!ts.isClassDeclaration(node)) return;
    const ctrl = decorators(node).find((d) => decoName(d) === 'Controller');
    if (!ctrl) return;
    const prefix = decoArg(ctrl);
    for (const m of node.members) {
      if (!ts.isMethodDeclaration(m)) continue;
      const verb = decorators(m).find((d) => ['Post', 'Put', 'Patch', 'Delete'].includes(decoName(d)));
      if (!verb) continue;
      const path = join(prefix, decoArg(verb)).replace(/:[A-Za-z]+/g, '*');
      const route = `${decoName(verb).toUpperCase()} ${path}`;
      const audited = reachesAudit(m);
      const ex = exemptions.find((e) => e.re.test(route));
      if (ex) ex.used = true;
      routes.push({
        route,
        audited,
        exempt: ex?.why ?? null,
        where: `${relative(app, sf.fileName)}:${sf.getLineAndCharacterOfPosition(m.getStart(sf)).line + 1}`,
      });
    }
  });
}

const missing = routes.filter((r) => !r.audited && !r.exempt);
const stale = exemptions.filter((e) => !e.used).map((e) => e.p);
const auditedExempt = routes.filter((r) => r.audited && r.exempt);
if (LIST)
  for (const r of routes.sort((a, b) => a.route.localeCompare(b.route)))
    console.log(
      `${r.audited ? 'AUDIT ' : r.exempt ? 'exempt' : 'MISSING'}  ${r.route}${r.exempt ? `  — ${r.exempt}` : ''}`,
    );
console.log(
  `${routes.length} write routes: ${routes.filter((r) => r.audited).length} audited, ${routes.filter((r) => !r.audited && r.exempt).length} exempt (reason given), ${missing.length} missing`,
);
if (auditedExempt.length)
  console.log(
    `note: ${auditedExempt.length} exempt routes audit anyway (fine): ${auditedExempt.map((r) => r.route).join(', ')}`,
  );
if (stale.length)
  console.error(
    `✗ exemptions that match no route (remove them, so the list stays a true record): ${stale.join(', ')}`,
  );
if (missing.length) {
  console.error(
    `✗ write routes with no audit event and no exemption:\n  ${missing.map((r) => `${r.route}  (${r.where})`).join('\n  ')}`,
  );
}
if (missing.length || stale.length) process.exit(1);
console.log('✓ every write route audits or is exempt with a reason');
