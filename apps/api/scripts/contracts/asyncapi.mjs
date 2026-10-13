#!/usr/bin/env node
/**
 * AsyncAPI 3.0 generator for the Talkivio realtime gateway (Socket.IO, path
 * `/realtime/v1`, namespaces `/agent` and `/visitor`).
 *
 *   node apps/api/scripts/contracts/asyncapi.mjs   → contracts/asyncapi.yaml
 *
 * The document describes the server application: it *sends* `auth.ok`, durable
 * `event`, `ephemeral` and `control` frames and *receives* `subscribe`, `unsubscribe`,
 * `heartbeat` and `command` (each with a Socket.IO acknowledgement as the reply).
 *
 * Completeness checks (fail the run):
 *  - every `eventType: '…'` passed to `outbox.append(...)` (plus `stage(...)` /
 *    `emitExport(...)` helpers) has a payload schema in `packages/client/src/events/durable.ts`;
 *  - every `realtime.ephemeral(…, '<type>', …)` has a schema in `events/ephemeral.ts`;
 *  - every `registerAgent('…')` / `registerVisitor('…')` has a schema in `events/commands.ts`,
 *    and the handler, invoked with an empty payload, reports exactly the required fields
 *    the schema declares (probe of the real zod parse in the built API).
 * The output is validated with @asyncapi/parser; errors fail the run.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { API_DIR, CONTRACTS_DIR, GENERATED_HEADER, dedupeComponents, loadClientModule, snakeSchema, writeYaml, zodToJson } from './lib.mjs';
import { loadApi } from './routes.mjs';

const require = createRequire(resolve(API_DIR, 'package.json'));
const YAML = require('yaml');

function fail(msg) {
  console.error(`asyncapi: ${msg}`);
  process.exit(1);
}

const pascal = (type) =>
  type
    .split(/[._]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');

// ───────── source scanning ─────────
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(p);
  }
  return out.sort();
}

/** Text of a call starting at `open` (index of '('), balanced on parentheses. */
function callText(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

function scanSource() {
  const durable = new Map();
  const ephemeral = new Map();
  const commands = { agent: new Set(), visitor: new Set() };
  for (const file of sourceFiles(resolve(API_DIR, 'src'))) {
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(API_DIR.length + 1);
    for (const m of src.matchAll(/\.append\(/g)) {
      const text = callText(src, m.index + m.length - 1);
      const t = /eventType:\s*'([a-z_.]+)'/.exec(text);
      if (t) durable.set(t[1], rel);
    }
    for (const m of src.matchAll(/\b(?:this\.)?stage\(tx,\s*\w+,\s*'([a-z_.]+)'/g)) durable.set(m[1], rel);
    for (const m of src.matchAll(/\bemitExport\(tx,\s*\w+,\s*'([a-z_.]+)'/g)) durable.set(m[1], rel);
    for (const m of src.matchAll(/\.ephemeral\(/g)) {
      const text = callText(src, m.index + m.length - 1);
      const t = /'([a-z_]+\.[a-z_.]+)'/.exec(text);
      if (t) ephemeral.set(t[1], rel);
    }
    for (const m of src.matchAll(/registerAgent\('([a-z_.]+)'/g)) commands.agent.add(m[1]);
    for (const m of src.matchAll(/registerVisitor\('([a-z_.]+)'/g)) commands.visitor.add(m[1]);
  }
  return { durable, ephemeral, commands };
}

/** Instantiates the command-registering providers with stubs and probes each handler with `{}`. */
async function probeCommandHandlers() {
  const api = loadApi();
  const { CommandRegistry } = require(resolve(API_DIR, 'dist/realtime/command-registry.js'));
  const registry = new CommandRegistry();
  const providers = Reflect.getMetadata('providers', api.modules.DomainModule) ?? [];
  const stub = new Proxy({}, { get: () => () => { throw new Error('probe-stub'); } });
  for (const P of providers) {
    if (typeof P !== 'function') continue;
    const types = Reflect.getMetadata('design:paramtypes', P) ?? [];
    if (!types.includes(CommandRegistry)) continue;
    const inst = new P(...types.map((t) => (t === CommandRegistry ? registry : stub)));
    await inst.onModuleInit?.();
  }
  const probe = async (handler) => {
    try {
      await handler({ auth: stub, visitor: stub, connectionId: 'probe' }, { commandId: 'probe', type: 'probe', payload: {} });
      return [];
    } catch (err) {
      const fe = err?.extra?.fieldErrors;
      if (err?.code === 'VALIDATION_FAILED' && fe) return Object.keys(fe).sort();
      return [];
    }
  };
  const out = { agent: {}, visitor: {} };
  for (const [kind, map] of [['agent', registry.agent], ['visitor', registry.visitor]]) {
    for (const [type, handler] of map) out[kind][type] = await probe(handler);
  }
  return out;
}

async function main() {
  const ev = await loadClientModule('events/index.ts');
  const { ResourceSchemas } = await loadClientModule('schemas/index.ts');
  const { DurableEvents, EphemeralEvents, AgentCommands, VisitorCommands } = ev;

  // ── completeness against the source ──
  const scanned = scanSource();
  const problems = [];
  for (const [t, file] of scanned.durable) if (!DurableEvents[t]) problems.push(`durable event ${t} (${file}) has no schema in events/durable.ts`);
  for (const t of Object.keys(DurableEvents)) if (!scanned.durable.has(t)) problems.push(`events/durable.ts declares ${t} but no outbox.append emits it`);
  for (const [t, file] of scanned.ephemeral) if (!EphemeralEvents[t]) problems.push(`ephemeral ${t} (${file}) has no schema in events/ephemeral.ts`);
  for (const t of Object.keys(EphemeralEvents)) if (!scanned.ephemeral.has(t)) problems.push(`events/ephemeral.ts declares ${t} but nothing emits it`);
  for (const t of scanned.commands.agent) if (!AgentCommands[t]) problems.push(`agent command ${t} has no schema`);
  for (const t of Object.keys(AgentCommands)) if (!scanned.commands.agent.has(t)) problems.push(`AgentCommands.${t} is not registered`);
  for (const t of scanned.commands.visitor) if (!VisitorCommands[t]) problems.push(`visitor command ${t} has no schema`);
  for (const t of Object.keys(VisitorCommands)) if (!scanned.commands.visitor.has(t)) problems.push(`VisitorCommands.${t} is not registered`);

  const probed = await probeCommandHandlers();
  for (const [kind, specs] of [['agent', AgentCommands], ['visitor', VisitorCommands]]) {
    for (const [type, spec] of Object.entries(specs)) {
      const declared = (snakeSchema(zodToJson(spec.payload, 'input')).required ?? []).slice().sort();
      const actual = probed[kind][type];
      if (!actual) problems.push(`${kind} command ${type} not found at runtime`);
      else if (declared.join(',') !== actual.join(',')) problems.push(`${kind} command ${type}: schema requires [${declared}] but the handler requires [${actual}]`);
    }
  }
  const { RESCOPE_REASONS } = require(resolve(API_DIR, 'dist/realtime/realtime.service.js'));
  if (RESCOPE_REASONS && [...RESCOPE_REASONS].sort().join(',') !== [...ev.RESCOPE_REASONS].sort().join(',')) problems.push(`RESCOPE_REASONS differ: server [${[...RESCOPE_REASONS]}] vs events/envelope.ts [${ev.RESCOPE_REASONS}]`);
  if (problems.length) fail(`contract drift:\n  ${problems.join('\n  ')}`);

  // ── schemas ──
  let schemas = {};
  // Shared resources referenced by payloads (deduped into $refs below).
  for (const name of ['Message', 'StaffChat', 'PublicChat', 'PublicAgentProfile', 'Offer', 'Tag', 'VisitorSummary', 'AttachmentRef', 'LiveVisitorItem', 'LiveSessionItem', 'MonitorSnapshot', 'DepartmentLoad', 'Notification', 'EmergencyClosure', 'Invitation', 'OfflineReceipt']) {
    schemas[name] = snakeSchema(zodToJson(ResourceSchemas[name]));
  }
  const add = (name, zs, io = 'output') => {
    schemas[name] = snakeSchema(zodToJson(zs, io));
    return name;
  };
  const durableIndex = {};
  for (const [type, spec] of Object.entries(DurableEvents)) {
    const base = add(`${pascal(type)}Payload`, spec.payload);
    const pub = spec.public ? (spec.public === spec.payload ? base : add(`${pascal(type)}PublicPayload`, spec.public)) : null;
    durableIndex[type] = { base, pub, spec };
  }
  const ephemeralIndex = {};
  for (const [type, spec] of Object.entries(EphemeralEvents)) {
    const staff = spec.staff ? add(`${pascal(type)}EphemeralPayload`, spec.staff) : null;
    const pub = spec.public ? (spec.public === spec.staff ? staff : add(`${pascal(type)}EphemeralPublicPayload`, spec.public)) : null;
    ephemeralIndex[type] = { staff, pub, spec };
  }
  const commandIndex = { agent: {}, visitor: {} };
  for (const [kind, specs] of [['agent', AgentCommands], ['visitor', VisitorCommands]]) {
    for (const [type, spec] of Object.entries(specs)) {
      const prefix = `${kind === 'agent' ? 'Agent' : 'Visitor'}${pascal(type)}`;
      // ack results always carry {resource_id, seq?, version?} next to the resource (ch. 47).
      commandIndex[kind][type] = { payload: add(`${prefix}CommandPayload`, spec.payload, 'input'), result: add(`${prefix}CommandResult`, ev.withAckFields(spec.result)), spec };
    }
  }
  for (const [name, zs] of Object.entries({
    Scope: ev.ScopeSchema,
    HandshakeAuth: ev.HandshakeAuthSchema,
    AuthOk: ev.AuthOkSchema,
    ControlFrame: ev.ControlFrameSchema,
    Subscribe: ev.SubscribeSchema,
    Unsubscribe: ev.UnsubscribeSchema,
    Heartbeat: ev.HeartbeatSchema,
    SubscriptionOk: ev.SubscriptionOkSchema,
    SnapshotRequired: ev.SnapshotRequiredSchema,
    UnsubscribeAck: ev.UnsubscribeAckSchema,
    HeartbeatAck: ev.HeartbeatAckSchema,
    CommandError: ev.CommandErrorSchema,
  })) {
    add(name, zs, ['Subscribe', 'Unsubscribe', 'Heartbeat', 'HandshakeAuth'].includes(name) ? 'input' : 'output');
  }
  schemas = dedupeComponents(schemas, '#/components/schemas/');
  const ref = (n) => ({ $ref: `#/components/schemas/${n}` });

  // ── frames (inline envelopes so validators can be strict) ──
  const scopeSchema = (kinds) => ({ type: 'object', required: ['kind', 'id'], properties: { kind: { type: 'string', enum: kinds }, id: { type: 'string', maxLength: 64 } } });
  const durableFrame = (type, payloadName, kinds) => ({
    type: 'object',
    required: ['v', 'event_id', 'type', 'tenant_id', 'scope', 'cursor', 'occurred_at', 'aggregate_version', 'causation_id', 'payload'],
    properties: {
      v: { const: 1 },
      event_id: { type: 'string', format: 'uuid', description: 'Deduplicate on this (at-least-once delivery)' },
      type: { const: type },
      tenant_id: { type: 'string', format: 'uuid', description: 'Server supplied; never client authority' },
      scope: scopeSchema(kinds),
      cursor: { type: 'string', description: 'Opaque monotonic stream cursor (pass as `last_cursor` to resume)' },
      occurred_at: { type: 'string', format: 'date-time' },
      aggregate_version: { type: 'integer', description: 'Ignore frames older than the cached aggregate version' },
      causation_id: { type: ['string', 'null'], format: 'uuid' },
      payload: ref(payloadName),
    },
  });
  const ephemeralFrame = (type, payloadName, kinds) => ({
    type: 'object',
    required: ['v', 'type', 'scope', 'expires_at', 'payload'],
    properties: { v: { const: 1 }, type: { const: type }, scope: scopeSchema(kinds), expires_at: { type: 'string', format: 'date-time' }, payload: ref(payloadName) },
  });
  const commandFrame = (type, payloadName, expectedVersion) => ({
    type: 'object',
    required: ['command_id', 'type', 'payload'],
    properties: {
      v: { const: 1 },
      command_id: { type: 'string', minLength: 1, maxLength: 64, description: 'Client-generated; reuse it when retrying after network ambiguity' },
      type: { const: type },
      scope: ref('Scope'),
      ...(expectedVersion ? { expected_version: { type: 'integer', description: 'Aggregate version the client acted on' } } : {}),
      payload: ref(payloadName),
    },
  });
  const ackFrame = (resultName) => ({
    type: 'object',
    required: ['type', 'command_id', 'result', 'committed_at'],
    properties: { type: { const: 'command.ack' }, command_id: { type: 'string' }, result: ref(resultName), committed_at: { type: 'string', format: 'date-time' } },
  });

  // ── messages ──
  const messages = {};
  const msg = (key, def) => {
    if (messages[key]) fail(`duplicate message ${key}`);
    messages[key] = def;
    return key;
  };
  const ns = {
    agent: { audience: 'staff', channelMessages: {}, sendRefs: { auth: [], event: [], ephemeral: [], control: [] }, ops: {} },
    visitor: { audience: 'public', channelMessages: {}, sendRefs: { auth: [], event: [], ephemeral: [], control: [] }, ops: {} },
  };
  const attach = (nsKey, key) => {
    ns[nsKey].channelMessages[key] = { $ref: `#/components/messages/${key}` };
    return { $ref: `#/channels/${nsKey}/messages/${key}` };
  };

  for (const nsKey of ['agent', 'visitor']) {
    const n = ns[nsKey];
    const P = nsKey === 'agent' ? 'Agent' : 'Visitor';
    n.sendRefs.auth.push(attach(nsKey, msg(`${P}AuthOk`, { name: 'auth.ok', title: 'auth.ok', summary: 'Handshake accepted (first server frame).', payload: ref('AuthOk'), 'x-socketio-event': 'auth.ok' })));
    n.sendRefs.control.push(attach(nsKey, msg(`${P}AccessRevoked`, { name: 'control', title: 'access.revoked', summary: 'Access revoked; the server disconnects right after. Wipe principal-scoped caches.', description: `\`relogin_required\` is false for re-scope reasons (${ev.RESCOPE_REASONS.join(', ')}): the session stays valid, mint a fresh ticket and reconnect. It is true for every other reason (session_revoked, membership_suspended, tenant_unavailable, visitor_reset, …).`, payload: ref('ControlFrame'), 'x-socketio-event': 'control', 'x-talkivio-rescope-reasons': [...ev.RESCOPE_REASONS] })));

    for (const [type, d] of Object.entries(durableIndex)) {
      const kinds = nsKey === 'agent' ? d.spec.staffScopes : d.spec.publicScopes;
      if (!kinds.length) continue;
      const payloadName = nsKey === 'agent' ? d.base : d.pub;
      const key = msg(`${P}Event${pascal(type)}`, {
        name: 'event',
        title: type,
        summary: d.spec.summary,
        payload: durableFrame(type, payloadName, kinds),
        'x-socketio-event': 'event',
        'x-talkivio-event-type': type,
        'x-talkivio-audience': n.audience,
        'x-talkivio-aggregate': d.spec.aggregate,
      });
      n.sendRefs.event.push(attach(nsKey, key));
    }
    for (const [type, e] of Object.entries(ephemeralIndex)) {
      const kinds = nsKey === 'agent' ? e.spec.staffScopes : e.spec.publicScopes;
      const payloadName = nsKey === 'agent' ? e.staff : e.pub;
      if (!kinds.length || !payloadName) continue;
      const key = msg(`${P}Ephemeral${pascal(type)}`, {
        name: 'ephemeral',
        title: type,
        summary: e.spec.summary,
        payload: ephemeralFrame(type, payloadName, kinds),
        'x-socketio-event': 'ephemeral',
        'x-talkivio-event-type': type,
        'x-talkivio-audience': n.audience,
      });
      n.sendRefs.ephemeral.push(attach(nsKey, key));
    }

    // client → server
    const errKey = attach(nsKey, msg(`${P}CommandError`, { name: 'command.error', title: 'command.error', summary: 'Acknowledgement for a rejected command / subscription.', payload: ref('CommandError') }));
    const subscribeRef = attach(nsKey, msg(`${P}Subscribe`, { name: 'subscribe', title: 'subscribe', summary: `Join scopes and replay durable events after \`last_cursor\` (24 h retention).`, payload: ref('Subscribe'), 'x-socketio-event': 'subscribe' }));
    const okRef = attach(nsKey, msg(`${P}SubscriptionOk`, { name: 'subscription.ok', title: 'subscription.ok', payload: ref('SubscriptionOk') }));
    const snapRef = attach(nsKey, msg(`${P}SnapshotRequired`, { name: 'snapshot.required', title: 'snapshot.required', summary: 'Cursor expired: refetch REST snapshots, then resubscribe from `snapshot_cursor`.', payload: ref('SnapshotRequired') }));
    n.ops[`${nsKey}Subscribe`] = { action: 'receive', messages: [subscribeRef], reply: [okRef, snapRef, errKey], summary: 'subscribe {scopes, last_cursor?}' };
    {
      const unsubRef = attach(nsKey, msg(`${P}Unsubscribe`, { name: 'unsubscribe', title: 'unsubscribe', payload: ref('Unsubscribe'), 'x-socketio-event': 'unsubscribe' }));
      const unsubAck = attach(nsKey, msg(`${P}UnsubscribeAck`, { name: 'unsubscribe.ack', title: 'unsubscribe ack', payload: ref('UnsubscribeAck') }));
      n.ops[`${nsKey}Unsubscribe`] = { action: 'receive', messages: [unsubRef], reply: [unsubAck], summary: 'unsubscribe {scope_ids} (or {scopes}); a connection’s own stream cannot be left' };
    }
    const hbRef = attach(nsKey, msg(`${P}Heartbeat`, { name: 'heartbeat', title: 'heartbeat', summary: 'Application heartbeat (Engine.IO ping/pong also runs every 15 s).', payload: ref('Heartbeat'), 'x-socketio-event': 'heartbeat' }));
    const hbAck = attach(nsKey, msg(`${P}HeartbeatAck`, { name: 'heartbeat.ack', title: 'heartbeat ack', payload: ref('HeartbeatAck') }));
    n.ops[`${nsKey}Heartbeat`] = { action: 'receive', messages: [hbRef], reply: [hbAck], summary: 'heartbeat' };

    for (const [type, c] of Object.entries(commandIndex[nsKey])) {
      const cmdRef = attach(nsKey, msg(`${P}Command${pascal(type)}`, {
        name: 'command',
        title: `command ${type}`,
        summary: `${c.spec.summary} REST twin: ${c.spec.rest}.`,
        payload: commandFrame(type, c.payload, c.spec.expectedVersion),
        'x-socketio-event': 'command',
        'x-talkivio-command-type': type,
      }));
      const ackRef = attach(nsKey, msg(`${P}CommandAck${pascal(type)}`, { name: 'command.ack', title: `command.ack ${type}`, payload: ackFrame(c.result), 'x-talkivio-command-type': type }));
      n.ops[`${nsKey}Command${pascal(type)}`] = { action: 'receive', messages: [cmdRef], reply: [ackRef, errKey], summary: `command ${type}` };
    }
  }

  // ── channels & operations ──
  const channels = {};
  const operations = {};
  for (const nsKey of ['agent', 'visitor']) {
    const n = ns[nsKey];
    channels[nsKey] = {
      address: `/${nsKey}`,
      title: nsKey === 'agent' ? 'Agent namespace' : 'Visitor namespace',
      description:
        nsKey === 'agent'
          ? 'Dashboard sockets. Ticket from `POST /api/v1/socket-ticket` (session + CSRF). Browser Origin must be a dashboard origin. Auto-joined: own `agent:<membership_id>` scope. Subscribable: chat, queue (`none` = no department), team (`all`), visitor (`all` or site id), config (site id).'
          : 'Widget sockets. Ticket from `POST /widget/v1/socket-ticket` (visitor capability). Auto-joined: `visitor:<session_id>` and `config:<site_id>`. Subscribable: own chats only.',
      servers: [{ $ref: '#/servers/local' }],
      messages: n.channelMessages,
    };
    const chan = { $ref: `#/channels/${nsKey}` };
    operations[`${nsKey}SendAuthOk`] = { action: 'send', channel: chan, summary: 'auth.ok after a valid single-use ticket', messages: n.sendRefs.auth };
    operations[`${nsKey}SendEvents`] = { action: 'send', channel: chan, summary: 'Durable domain events (socket event `event`)', messages: n.sendRefs.event };
    operations[`${nsKey}SendEphemeral`] = { action: 'send', channel: chan, summary: 'Ephemeral frames (socket event `ephemeral`)', messages: n.sendRefs.ephemeral };
    operations[`${nsKey}SendControl`] = { action: 'send', channel: chan, summary: 'Control frames (socket event `control`)', messages: n.sendRefs.control };
    for (const [id, o] of Object.entries(n.ops)) {
      operations[id] = { action: o.action, channel: chan, summary: o.summary, messages: o.messages, reply: { channel: chan, messages: o.reply } };
    }
  }

  const outbox = {};
  for (const [type, d] of Object.entries(durableIndex)) {
    outbox[type] = {
      aggregate: d.spec.aggregate,
      staff_scopes: d.spec.staffScopes,
      public_scopes: d.spec.publicScopes,
      payload: ref(d.base),
      ...(d.pub ? { public_payload: ref(d.pub) } : {}),
      summary: d.spec.summary,
    };
  }

  const doc = {
    asyncapi: '3.0.0',
    info: {
      title: 'Talkivio Realtime API',
      version: '1.0.0',
      description: [
        'Socket.IO v4 gateway (ADR 0003). Connect to `<origin>/<namespace>` with `path: "/realtime/v1"` and `auth: { ticket }` (single-use, 30 s, minted over REST; never in the URL).',
        'This document describes the server: it sends `auth.ok`, `event` (durable, replayable by cursor), `ephemeral` and `control` frames, and receives `subscribe`, `unsubscribe`, `heartbeat` and `command` whose Socket.IO acknowledgement is the reply.',
        'All frames are snake_case JSON. Delivery is at least once: deduplicate on `event_id`, ignore stale `aggregate_version`. Internal-only outbox events are listed under `x-talkivio-outbox` (they feed workers, triggers and webhooks, not sockets).',
        `Handshake failures surface as Socket.IO \`connect_error\` with message ${ev.CONNECT_ERRORS.join(' | ')}.`,
      ].join('\n\n'),
    },
    defaultContentType: 'application/json',
    servers: {
      local: {
        host: 'localhost:4000',
        protocol: 'ws',
        pathname: '/realtime/v1',
        description: 'Local development gateway (Socket.IO over WebSocket; Engine.IO ping every 15 s, 64 KiB max frame).',
        security: [{ $ref: '#/components/securitySchemes/socketTicket' }],
      },
    },
    channels,
    operations,
    components: {
      schemas,
      messages,
      securitySchemes: {
        socketTicket: {
          type: 'apiKey',
          in: 'user',
          description: 'Single-use 30 s ticket (`rdtk_…`) sent as the Socket.IO CONNECT auth payload `{ ticket }`. Agents: `POST /api/v1/socket-ticket`; visitors: `POST /widget/v1/socket-ticket`.',
        },
      },
    },
    'x-talkivio-outbox': outbox,
  };

  // ── validate with the official parser ──
  const { Parser } = require('@asyncapi/parser');
  const parser = new Parser();
  const text = YAML.stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false });
  const { diagnostics } = await parser.parse(text);
  const errors = diagnostics.filter((d) => d.severity === 0);
  if (errors.length) fail(`AsyncAPI validation failed:\n${errors.map((e) => `  ${e.code}: ${e.message} @ ${(e.path ?? []).join('.')}`).join('\n')}`);
  const warnings = diagnostics.filter((d) => d.severity === 1);
  if (warnings.length) console.warn(`asyncapi: ${warnings.length} warning(s): ${[...new Set(warnings.map((w) => w.code))].join(', ')}`);

  writeYaml(resolve(CONTRACTS_DIR, 'asyncapi.yaml'), doc, GENERATED_HEADER('apps/api/scripts/contracts/asyncapi.mjs'));
  const internalOnly = Object.values(DurableEvents).filter((s) => !s.staffScopes.length && !s.publicScopes.length).length;
  console.log(
    `asyncapi: ${Object.keys(DurableEvents).length} durable event types (${internalOnly} internal-only), ${Object.keys(EphemeralEvents).length} ephemeral, ${Object.keys(AgentCommands).length} agent + ${Object.keys(VisitorCommands).length} visitor commands, ${Object.keys(messages).length} messages → contracts/asyncapi.yaml`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
