/**
 * Shared helpers for the contract generators: zod → JSON Schema (2020-12 flavoured,
 * as used by OpenAPI 3.1 and AsyncAPI 3.0), wire-case conversion that mirrors
 * `apps/api/src/common/wire.ts`, component de-duplication and stable YAML output.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const REPO_DIR = resolve(API_DIR, '../..');
export const CONTRACTS_DIR = resolve(REPO_DIR, 'contracts');
export const CLIENT_SRC = resolve(REPO_DIR, 'packages/client/src');

const require = createRequire(resolve(API_DIR, 'package.json'));
const { zodToJsonSchema } = require('zod-to-json-schema');
const YAML = require('yaml');

/** Same list as `apps/api/src/common/wire.ts` — values under these keys keep their inner keys. */
export const OPAQUE_KEYS = new Set(['customFields', 'custom_fields', 'customFieldSources', 'custom_field_sources', 'fields', 'attributes', 'safeDiff', 'safe_diff', 'metadata', 'fieldErrors', 'field_errors']);
export const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const camel = (k) => k.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

/** Loads the camelCase resource / event schemas from `packages/client/src` (Node type stripping). */
export async function loadClientModule(rel) {
  return import(pathToFileURL(resolve(CLIENT_SRC, rel)).href);
}

function normalize(node, root = true) {
  if (Array.isArray(node)) return node.map((n) => normalize(n, false));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (root && (k === '$schema' || k === 'definitions')) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, normalize(pv, false)])) : normalize(v, false);
  }
  // draft-07 tuples → 2020-12 prefixItems
  if (Array.isArray(out.items)) {
    out.prefixItems = out.items;
    delete out.items;
    if ('additionalItems' in out) {
      out.items = out.additionalItems;
      delete out.additionalItems;
    }
  }
  return out;
}

/**
 * zod (v3) → JSON Schema. Objects declared `.strict()` get `additionalProperties: false`;
 * plain (stripping) objects leave the keyword out (unknown keys are ignored/allowed).
 */
export function zodToJson(schema, io = 'output') {
  const out = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
    effectStrategy: 'input',
    pipeStrategy: io === 'input' ? 'input' : 'output',
    removeAdditionalStrategy: 'strict',
    allowedAdditionalProperties: undefined,
    rejectedAdditionalProperties: false,
    strictUnions: true,
  });
  return normalize(out);
}

/**
 * Converts property names to the snake_case wire form (`wire.ts#toWire`), leaving the
 * value schemas of opaque keys untouched. `verbatim` lists top-level body keys whose
 * values are passed through as-is by `VerbatimKeysPipe`.
 */
export function snakeSchema(node, verbatim = []) {
  if (Array.isArray(node)) return node.map((n) => snakeSchema(n));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) {
        const isVerbatim = verbatim.includes(pk);
        const name = isVerbatim ? pk : snake(pk);
        out.properties[name] = OPAQUE_KEYS.has(pk) || isVerbatim ? pv : snakeSchema(pv);
      }
    } else if (k === 'required' && Array.isArray(v)) {
      out.required = v.map((r) => (verbatim.includes(r) ? r : snake(r)));
    } else if (['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains'].includes(k) && v && typeof v === 'object') {
      out[k] = snakeSchema(v);
    } else if (['anyOf', 'oneOf', 'allOf', 'prefixItems'].includes(k) && Array.isArray(v)) {
      out[k] = v.map((x) => snakeSchema(x));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Deterministic JSON (sorted keys) for structural comparison. */
export function canonical(node) {
  if (Array.isArray(node)) return `[${node.map(canonical).join(',')}]`;
  if (node && typeof node === 'object') {
    return `{${Object.keys(node)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(node[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(node);
}

/**
 * Replaces nested sub-schemas that are structurally identical to a named component
 * with `$ref`s (largest match first, never the component root itself).
 */
export function dedupeComponents(components, refPrefix) {
  const byShape = new Map();
  for (const [name, s] of Object.entries(components)) {
    const key = canonical(s);
    // Only named object shapes are worth a $ref (records and scalars stay inline).
    if (!byShape.has(key) && s && typeof s === 'object' && s.properties) byShape.set(key, name);
  }
  const walk = (node, self, root) => {
    if (Array.isArray(node)) return node.map((n) => walk(n, self, false));
    if (!node || typeof node !== 'object') return node;
    if (!root) {
      const hit = byShape.get(canonical(node));
      if (hit && hit !== self) return { $ref: `${refPrefix}${hit}` };
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'properties' || k === 'patternProperties') {
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv, self, false)]));
      } else if (k === 'enum' || k === 'const' || k === 'default' || k === 'examples' || k === 'required') {
        out[k] = v;
      } else {
        out[k] = walk(v, self, false);
      }
    }
    return out;
  };
  return Object.fromEntries(Object.entries(components).map(([name, s]) => [name, walk(s, name, true)]));
}

/** `export type ErrorCode = | 'A' | 'B' …` from `apps/api/src/common/http.ts`. */
export function serverErrorCodes() {
  const src = readFileSync(resolve(API_DIR, 'src/common/http.ts'), 'utf8');
  const m = /export type ErrorCode =([\s\S]*?);/.exec(src);
  if (!m) throw new Error('ErrorCode union not found in apps/api/src/common/http.ts');
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
}

/** ch. 76 error code inventory (docs/master-prompt.txt). */
export function specErrorCodes() {
  const src = readFileSync(resolve(REPO_DIR, 'docs/master-prompt.txt'), 'utf8');
  const m = /Error code inventory\s*\n([\s\S]*?)Machine codes stay stable/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/\b([A-Z][A-Z_]{3,})\b/g)].map((x) => x[1]);
}

export function writeYaml(file, doc, header) {
  mkdirSync(dirname(file), { recursive: true });
  const body = YAML.stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false, singleQuote: false });
  writeFileSync(file, `${header}\n${body}`);
}

export function readYaml(file) {
  return YAML.parse(readFileSync(file, 'utf8'));
}

export const GENERATED_HEADER = (generator) =>
  `# GENERATED FILE — do not edit by hand.\n# Regenerate with \`pnpm --filter @talkivio/api contracts\` (${generator}).`;
