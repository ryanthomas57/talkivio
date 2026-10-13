#!/usr/bin/env node
/**
 * OpenAPI 3.1 generator for the Talkivio HTTP API.
 *
 *   node apps/api/scripts/contracts/openapi.mjs   → contracts/openapi.yaml (+ contracts/coverage.json)
 *
 * Sources of truth:
 *  - routes, guards, permissions, recent-auth, token access, headers, path/query params and
 *    request bodies: Nest decorator metadata and the zod schemas held by `body()` /
 *    `verbatimBody()` pipes in the built API (`apps/api/dist`, loaded without starting it);
 *  - response shapes: `packages/client/src/schemas` mapped per operation in `responses.mjs`;
 *  - error codes: the `ErrorCode` union in `apps/api/src/common/http.ts`.
 * The result is validated with @readme/openapi-parser; any error fails the run.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { enumerateRoutes, loadApi } from './routes.mjs';
import { RAW_REQUEST_BODIES, RESPONSES } from './responses.mjs';
import { CONTRACTS_DIR, GENERATED_HEADER, dedupeComponents, loadClientModule, serverErrorCodes, snake, snakeSchema, specErrorCodes, writeYaml, zodToJson } from './lib.mjs';

const REF = (name) => ({ $ref: `#/components/schemas/${name}` });
const RESP = (name) => ({ $ref: `#/components/responses/${name}` });
const SAFE = new Set(['get', 'head', 'options']);

const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const tagOf = (controller) => controller.replace(/Controller$/, '');

function fail(msg) {
  console.error(`openapi: ${msg}`);
  process.exit(1);
}

async function main() {
  const api = loadApi();
  const routes = enumerateRoutes(api);
  const { ResourceSchemas } = await loadClientModule('schemas/index.ts');

  // ───────── components ─────────
  const resourceNames = Object.keys(ResourceSchemas);
  let schemas = {};
  for (const name of resourceNames) schemas[name] = snakeSchema(zodToJson(ResourceSchemas[name], 'output'));
  schemas = dedupeComponents(schemas, '#/components/schemas/');

  const codes = serverErrorCodes();
  const inventory = specErrorCodes();
  const missingFromServer = inventory.filter((c) => !codes.includes(c));
  if (missingFromServer.length) fail(`ch. 76 error codes missing from ErrorCode: ${missingFromServer.join(', ')}`);

  Object.assign(schemas, {
    Meta: { type: 'object', required: ['request_id'], properties: { request_id: { type: 'string', description: 'Echoed X-Request-Id' } } },
    PageInfo: {
      type: 'object',
      required: ['next_cursor', 'has_more'],
      properties: {
        next_cursor: { type: ['string', 'null'], description: 'Opaque cursor bound to the filter set; null on the last page' },
        has_more: { type: 'boolean' },
        total: { type: 'integer' },
      },
    },
    ErrorCode: {
      type: 'string',
      enum: codes,
      description: `Stable machine codes (ch. 76 inventory: ${inventory.join(', ')}; plus server extensions). Human messages localize; \`retryable\` only means a retry with the same command identity may help.`,
    },
    ErrorEnvelope: {
      type: 'object',
      required: ['error', 'meta'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message', 'retryable'],
          properties: {
            code: REF('ErrorCode'),
            message: { type: 'string' },
            retryable: { type: 'boolean' },
            field_errors: { type: 'object', description: 'snake_case field path → messages (opaque map)', additionalProperties: { type: 'array', items: { type: 'string' } } },
            details: { description: 'Safe structured context (e.g. current version on VERSION_CONFLICT)' },
          },
        },
        meta: { type: 'object', properties: { request_id: { type: 'string' } } },
      },
    },
  });

  const errorResponse = (description, example) => ({
    description,
    content: { 'application/json': { schema: REF('ErrorEnvelope'), ...(example ? { example } : {}) } },
  });
  const responses = {
    BadRequest: errorResponse('Malformed JSON or path parameter (e.g. a non-UUID id) — `VALIDATION_FAILED`.'),
    Unauthorized: errorResponse('Not authenticated (`AUTH_REQUIRED`, `TOKEN_EXPIRED`, …).'),
    Forbidden: errorResponse('Authenticated but not allowed: missing permission or CSRF token (`PERMISSION_DENIED`), `RECENT_AUTH_REQUIRED`, `MFA_REQUIRED`, `ORIGIN_NOT_ALLOWED`, `CONSENT_REQUIRED`.'),
    NotFound: errorResponse('Unknown or hidden object (sensitive existence is always 404).'),
    Conflict: errorResponse('Version, idempotency or state conflict (`VERSION_CONFLICT`, `IDEMPOTENCY_MISMATCH`, `CAPACITY_EXCEEDED`, `CHAT_CLOSED`, `OFFER_WITHDRAWN`, …).', {
      error: { code: 'CAPACITY_EXCEEDED', message: 'Your chat capacity is full.', retryable: false },
      meta: { request_id: 'req-2f77' },
    }),
    ValidationFailed: errorResponse('Request does not match the schema (`VALIDATION_FAILED` with `field_errors`).', {
      error: { code: 'VALIDATION_FAILED', message: 'Check the highlighted fields.', retryable: false, field_errors: { email: ['Enter a valid email address.'] } },
      meta: { request_id: 'req-98bc' },
    }),
    PreconditionRequired: errorResponse('`If-Match` / `expected_version` missing on a versioned write (`PRECONDITION_REQUIRED`).'),
    RateLimited: {
      ...errorResponse('Rate limited (`RATE_LIMITED`); honour `Retry-After`.'),
      headers: { 'Retry-After': { description: 'Seconds to wait', schema: { type: 'integer' } } },
    },
    Error: errorResponse('Unexpected error (`INTERNAL`, `SERVICE_UNAVAILABLE`, `INTEGRATION_UNAVAILABLE`).'),
  };

  const parameters = {
    IdempotencyKey: {
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'Command idempotency (ch. 40): same key + same payload replays the original status and body for 24 h; same key + different payload → 409 `IDEMPOTENCY_MISMATCH`.',
      schema: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[\\w-]+$' },
    },
    IfMatch: {
      name: 'If-Match',
      in: 'header',
      required: false,
      description: 'Entity version precondition (`3`, `"3"` or `W/"3"`); alternatively send `expected_version` in the body. Missing on a required write → 428, stale → 409.',
      schema: { type: 'string' },
    },
  };

  const securitySchemes = {
    sessionCookie: { type: 'apiKey', in: 'cookie', name: 'rd_session', description: 'Dashboard session (HttpOnly). The active tenant comes from the server-side session.' },
    csrfToken: { type: 'apiKey', in: 'header', name: 'x-csrf-token', description: 'Session-bound CSRF token (value of the `rd_csrf` cookie); required on every non-GET request made with a session.' },
    integrationToken: { type: 'http', scheme: 'bearer', bearerFormat: 'rdt_…', description: 'Tenant integration token; accepted only on operations marked `x-talkivio-token-access`.' },
    visitorCapability: { type: 'http', scheme: 'bearer', bearerFormat: 'rdv1.…', description: 'Short-lived visitor capability from `POST /widget/v1/sessions` (scoped to tenant/site/visitor/session).' },
    identityJwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Customer-backend JWT signed with the source site identity secret (aud "talkivio handoff").' },
  };

  // ───────── operations ─────────
  const paths = {};
  const tags = new Set();
  const operationIds = new Set();
  const coverage = { operations: 0, jsonTyped: 0, noContent: 0, raw: 0, unmapped: [] };
  const typedOps = [];

  for (const r of routes) {
    const key = `${r.controller}.${r.handler}`;
    const map = RESPONSES[key];
    if (!map) {
      coverage.unmapped.push(`${r.method.toUpperCase()} ${r.path} (${key})`);
      continue;
    }
    const isWidget = r.path.startsWith('/widget/');
    const visitorGuard = r.guards.some((g) => /VisitorGuard$/.test(g));
    const mutation = !SAFE.has(r.method);
    const params = [];
    const pathNames = [...r.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    let hasUuidParam = false;
    for (const name of pathNames) {
      const p = r.params.find((x) => x.in === 'path' && x.data === name);
      const uuid = !!p?.pipes.some((pp) => pp.name === 'ParseUUIDPipe');
      hasUuidParam ||= uuid;
      params.push({ name, in: 'path', required: true, schema: uuid ? { type: 'string', format: 'uuid' } : { type: 'string' } });
    }
    let hasSchema = false;
    for (const p of r.params.filter((x) => x.in === 'query')) {
      const pipe = p.pipes.find((x) => x.kind === 'wire' || x.kind === 'verbatim');
      if (pipe) {
        hasSchema = true;
        const js = snakeSchema(zodToJson(pipe.schema, 'input'));
        const required = new Set(js.required ?? []);
        for (const [name, s] of Object.entries(js.properties ?? {})) params.push({ name, in: 'query', required: required.has(name), schema: s });
      } else if (typeof p.data === 'string') {
        params.push({ name: p.data, in: 'query', required: p.data === 'sig', schema: { type: 'string' }, ...(p.data === 'sig' ? { description: 'Signed short-lived grant from the corresponding download/upload descriptor' } : {}) });
      }
    }
    const headerNames = r.params.filter((x) => x.in === 'header' && typeof x.data === 'string').map((x) => x.data.toLowerCase());
    if (headerNames.includes('idempotency-key')) params.push({ $ref: '#/components/parameters/IdempotencyKey' });
    if (headerNames.includes('if-match')) params.push({ $ref: '#/components/parameters/IfMatch' });

    // request body
    let requestBody;
    const bodyParam = r.params.find((x) => x.in === 'body');
    const bodyPipe = bodyParam?.pipes.find((x) => x.kind === 'wire' || x.kind === 'verbatim');
    if (bodyPipe) {
      hasSchema = true;
      const js = snakeSchema(zodToJson(bodyPipe.schema, 'input'), bodyPipe.verbatim ?? []);
      requestBody = { required: (js.required ?? []).length > 0, content: { 'application/json': { schema: js } } };
      if (bodyPipe.verbatim?.length) requestBody.description = `Keys kept verbatim (not case-converted): ${bodyPipe.verbatim.join(', ')}.`;
    } else if (RAW_REQUEST_BODIES[key]) {
      const rb = RAW_REQUEST_BODIES[key];
      requestBody = { required: true, description: rb.description, content: { [rb.contentType]: { schema: { type: 'string', contentEncoding: 'binary' } } } };
    }

    // security
    let security;
    if (isWidget) {
      if (visitorGuard) security = [{ visitorCapability: [] }];
      else if (headerNames.includes('authorization')) security = [{ identityJwt: [] }];
      else security = [];
    } else if (r.flags.public) {
      security = mutation ? [{}, { sessionCookie: [], csrfToken: [] }] : [];
    } else {
      security = [mutation ? { sessionCookie: [], csrfToken: [] } : { sessionCookie: [] }];
      if (r.flags.tokenAllowed) security.push({ integrationToken: [] });
    }
    const authenticated = !(isWidget ? !visitorGuard && !headerNames.includes('authorization') : r.flags.public);

    // success responses
    const opResponses = {};
    const defaultStatus = r.httpCode ?? (r.method === 'post' ? 201 : 200);
    const status = map.status ?? (map.noContent ? 204 : defaultStatus);
    const description = map.note ?? 'Success';
    let kind;
    if (map.noContent) {
      opResponses[String(status === 204 ? 204 : status)] = { description: 'No content' };
      kind = 'noContent';
    } else if (map.raw) {
      kind = map.raw.redirect ? 'noContent' : map.raw.schema ? 'json' : 'raw';
      if (map.raw.redirect) {
        opResponses['302'] = { description: map.raw.description, headers: { Location: { schema: { type: 'string' } } } };
      } else {
        const fallback = map.raw.contentType.includes('json') ? {} : { type: 'string', ...(['application/octet-stream', '*/*'].includes(map.raw.contentType) ? { contentEncoding: 'binary' } : {}) };
        const content = { [map.raw.contentType]: { schema: map.raw.schema ?? fallback } };
        opResponses[String(map.raw.status ?? 200)] = { description: map.raw.description, content };
        for (const s of map.raw.alt ?? []) opResponses[String(s)] = { description: map.raw.description, content };
      }
    } else {
      kind = 'json';
      const name = map.data ?? map.list ?? map.page;
      if (!schemas[name]) fail(`${key}: unknown response schema ${name}`);
      const dataSchema = map.data ? REF(name) : { type: 'array', items: REF(name) };
      const envelope = {
        type: 'object',
        required: map.page ? ['data', 'page', 'meta'] : ['data', 'meta'],
        properties: { data: dataSchema, ...(map.page ? { page: REF('PageInfo') } : {}), meta: REF('Meta') },
      };
      const resp = { description, content: { 'application/json': { schema: envelope } }, ...(map.headers ? { headers: map.headers } : {}) };
      opResponses[String(status)] = resp;
      for (const s of map.alt ?? []) opResponses[String(s)] = resp;
      typedOps.push({ key, method: r.method, path: r.path, status, alt: map.alt ?? [], schema: name, envelope: map.page ? 'page' : map.list ? 'list' : 'single' });
    }
    coverage.operations++;
    if (kind === 'json') coverage.jsonTyped++;
    else if (kind === 'raw') coverage.raw++;
    else coverage.noContent++;

    // error responses
    if (hasUuidParam || requestBody) opResponses['400'] = RESP('BadRequest');
    if (authenticated) {
      opResponses['401'] = RESP('Unauthorized');
      opResponses['403'] = RESP('Forbidden');
    } else if (mutation && !isWidget) {
      opResponses['403'] = RESP('Forbidden');
    }
    if (pathNames.length) opResponses['404'] = RESP('NotFound');
    if (mutation) opResponses['409'] = RESP('Conflict');
    if (hasSchema || headerNames.includes('idempotency-key')) opResponses['422'] = RESP('ValidationFailed');
    if (headerNames.includes('if-match')) opResponses['428'] = RESP('PreconditionRequired');
    opResponses['429'] = RESP('RateLimited');
    opResponses.default = RESP('Error');

    const tag = tagOf(r.controller);
    tags.add(tag);
    const operationId = `${lowerFirst(tag)}${upperFirst(r.handler)}`;
    if (operationIds.has(operationId)) fail(`duplicate operationId ${operationId}`);
    operationIds.add(operationId);

    const op = {
      operationId,
      tags: [tag],
      summary: `${r.method.toUpperCase()} ${r.path}`,
      ...(params.length ? { parameters: params } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: Object.fromEntries(Object.entries(opResponses).sort(([a], [b]) => (a === 'default' ? 1 : b === 'default' ? -1 : Number(a) - Number(b)))),
      security,
      'x-talkivio-handler': key,
      ...(r.flags.require.length ? { 'x-talkivio-permissions': r.flags.require } : {}),
      ...(r.flags.recentAuth ? { 'x-talkivio-recent-auth': true } : {}),
      ...(r.flags.tokenAllowed ? { 'x-talkivio-token-access': true } : {}),
      ...(r.flags.userScoped ? { 'x-talkivio-user-scoped': true } : {}),
      ...(r.flags.allowPendingMfa ? { 'x-talkivio-allow-pending-mfa': true } : {}),
      ...(r.guards.length ? { 'x-talkivio-guards': r.guards } : {}),
      ...(kind === 'raw' ? { 'x-talkivio-untyped': true, 'x-talkivio-media': map.raw.contentType } : {}),
    };
    paths[r.path] ??= {};
    if (paths[r.path][r.method]) fail(`duplicate route ${r.method} ${r.path}`);
    paths[r.path][r.method] = op;
  }

  if (coverage.unmapped.length) fail(`routes without a response contract in responses.mjs:\n  ${coverage.unmapped.join('\n  ')}`);
  const stale = Object.keys(RESPONSES).filter((k) => !routes.some((r) => `${r.controller}.${r.handler}` === k));
  if (stale.length) fail(`responses.mjs entries without a route: ${stale.join(', ')}`);

  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'Talkivio API',
      version: '1.0.0',
      description: [
        'Generated from the running code (Nest metadata + zod schemas). Agent API under `/api/v1` (session cookie + CSRF, or `Bearer rdt_…` integration tokens where marked);',
        'public widget API under `/widget/v1` (site key bootstrap, then a `Bearer rdv1.…` visitor capability).',
        'Wire format: snake_case JSON in `{data, meta}` envelopes; lists that page return `{data, page:{next_cursor,has_more}, meta}`;',
        'errors are `{error:{code,message,retryable,field_errors?}, meta}`. Values under opaque keys (custom_fields, fields, attributes, metadata, safe_diff, field_errors) keep their keys.',
        'Realtime contract: see `asyncapi.yaml`.',
      ].join(' '),
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local development API' }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    components: { schemas, responses, parameters, securitySchemes },
  };

  // ───────── validate with a real parser ─────────
  const { validate, compileErrors } = await import('@readme/openapi-parser');
  const result = await validate(structuredClone(doc));
  if (!result.valid) fail(`OpenAPI validation failed:\n${compileErrors(result)}`);
  if (result.warnings?.length) console.warn(`openapi: ${result.warnings.length} warning(s)`, result.warnings.slice(0, 5));

  writeYaml(resolve(CONTRACTS_DIR, 'openapi.yaml'), doc, GENERATED_HEADER('apps/api/scripts/contracts/openapi.mjs'));
  const covOut = {
    operations: coverage.operations,
    json_typed: coverage.jsonTyped,
    no_content: coverage.noContent,
    untyped_media: coverage.raw,
    untyped_media_operations: Object.entries(paths).flatMap(([p, ops]) => Object.entries(ops).filter(([, o]) => o['x-talkivio-untyped']).map(([m, o]) => `${m.toUpperCase()} ${p} (${o['x-talkivio-media']})`)),
    components: Object.keys(schemas).length,
    typed_operations: typedOps.map((o) => `${o.method.toUpperCase()} ${o.path}`),
  };
  writeFileSync(resolve(CONTRACTS_DIR, 'coverage.json'), `${JSON.stringify(covOut, null, 2)}\n`);
  console.log(
    `openapi: ${coverage.operations} operations — ${coverage.jsonTyped} typed JSON, ${coverage.noContent} no-content (204/302), ${coverage.raw} untyped media (x-talkivio-untyped); ${Object.keys(schemas).length} schemas → contracts/openapi.yaml`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
