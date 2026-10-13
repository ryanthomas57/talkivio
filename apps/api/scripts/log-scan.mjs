#!/usr/bin/env node
/**
 * Log hygiene gate (release audit AUD-72-11: logs exclude secrets, bodies and unnecessary PII).
 *
 * Scans API/worker logs written while the e2e suites ran and fails when any of them contains
 * credentials, cookies, bearer/identity secrets, token-bearing query strings, payment-card
 * numbers, e2e message bodies or email addresses. The only lines skipped are the console
 * mailer's development output (`[console mail]` header and body), which production refuses
 * (EMAIL_PROVIDER=console is rejected when NODE_ENV=production).
 *
 * Usage: node scripts/log-scan.mjs <log> [<log> ...] [--report <file.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const reportAt = args.indexOf('--report');
const report = reportAt >= 0 ? args.splice(reportAt, 2)[1] : null;
if (!args.length) {
  console.error('usage: log-scan.mjs <log> [<log> ...] [--report <file.json>]');
  process.exit(2);
}

const RULES = [
  { id: 'e2e-password', re: /correct horse battery|another strong passphrase/ },
  { id: 'card-number', re: /\b4242[ -]?4242[ -]?4242[ -]?4242\b/ },
  { id: 'e2e-message-body', re: /Can you help with a refund|Please call me back|I need help with my order/ },
  { id: 'session-cookie', re: /rd_session=|rd_csrf=/ },
  { id: 'bearer-token', re: /Bearer [A-Za-z0-9._~+/-]{12,}/ },
  { id: 'identity-secret', re: /\brdid_[A-Za-z0-9_-]{8,}/ },
  { id: 'token-query', re: /[?&](token|grant|sig|signature|capability|ticket|invite)=[^&\s"']{8,}/ },
  { id: 'email-address', re: /[A-Za-z0-9._%+-]+@(?:example\.com|talkivio\.test)\b/ },
];
const appSecret = process.env.APP_SECRET ?? '';
if (appSecret.length >= 16) RULES.push({ id: 'app-secret', test: (line) => line.includes(appSecret) });

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const newRecord = (s) => /^\[\d{2}:\d{2}:\d{2}]/.test(s) || s.startsWith('{');
const findings = [];
let scanned = 0;
let skipped = 0;
for (const file of args) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let inMailBody = false;
  lines.forEach((raw, i) => {
    const line = strip(raw);
    if (inMailBody && !newRecord(line)) {
      skipped++;
      return;
    }
    inMailBody = false;
    if (line.includes('[console mail')) {
      skipped++;
      inMailBody = line.includes('[console mail body');
      return;
    }
    scanned++;
    for (const r of RULES) {
      const hit = r.test ? r.test(line) : r.re.test(line);
      if (!hit) continue;
      // Excerpts never print any matched value (all rules are masked).
      const excerpt = RULES.reduce((t, x) => (x.re ? t.replace(new RegExp(x.re.source, 'g'), '<redacted>') : appSecret ? t.split(appSecret).join('<redacted>') : t), line.trim());
      findings.push({ file, line: i + 1, rule: r.id, excerpt: excerpt.slice(0, 120) });
    }
  });
}

const byRule = findings.reduce((m, f) => ({ ...m, [f.rule]: (m[f.rule] ?? 0) + 1 }), {});
console.log(`[log-scan] ${args.length} file(s), ${scanned} lines scanned, ${skipped} development console-mail lines skipped`);
for (const f of findings.slice(0, 40)) console.log(`  ✗ ${f.rule} ${f.file}:${f.line} ${f.excerpt}`);
console.log(findings.length ? `[log-scan] FAIL ${JSON.stringify(byRule)}` : '[log-scan] PASS — no secrets, cookies, tokens, card numbers, message bodies or email addresses');
if (report) writeFileSync(report, `${JSON.stringify({ files: args, scanned, skipped, findings: findings.length, by_rule: byRule, rules: RULES.map((r) => r.id) }, null, 2)}\n`);
process.exit(findings.length ? 1 : 0);
