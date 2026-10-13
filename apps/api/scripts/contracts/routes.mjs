/**
 * Enumerates every HTTP route of the built API (`apps/api/dist`) from Nest
 * decorator metadata — no application context, no network, no database.
 *
 * Mirrors `bootstrap.ts`: global prefix `api/v1` except `widget/*` and `health/*`.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(API_DIR, 'package.json'));

const PARAM = { REQUEST: 0, RESPONSE: 1, NEXT: 2, BODY: 3, QUERY: 4, PARAM: 5, HEADERS: 6, SESSION: 7, FILE: 8, FILES: 9, HOST: 10, IP: 11, RAW_BODY: 12 };
const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head', 'search'];
const PREFIX_EXCLUDED = [/^widget(\/|$)/, /^health(\/|$)/];

const META = {
  public: 'rd:public',
  userScoped: 'rd:user-scoped',
  require: 'rd:require',
  allowPendingMfa: 'rd:allow-pending-mfa',
  tokenAllowed: 'rd:token-allowed',
  recentAuth: 'rd:recent-auth',
  auditedRequire: 'rd:audited-permission',
};

function join(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== '' && p !== '/')
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/** Loads the compiled API module graph (pure `require`, nothing is started). */
export function loadApi() {
  require('reflect-metadata');
  // Prevent accidental side effects if a module reads configuration at import time.
  process.env.TALKIVIO_PROCESS ??= 'contracts';
  const modules = require(resolve(API_DIR, 'dist/modules.js'));
  const http = require(resolve(API_DIR, 'dist/common/http.js'));
  const wire = require(resolve(API_DIR, 'dist/common/wire.js'));
  let verbatimPipe = null;
  try {
    verbatimPipe = require(resolve(API_DIR, 'dist/features/triggers/http-utils.js')).VerbatimKeysPipe;
  } catch {
    /* optional */
  }
  return { modules, http, wire, VerbatimKeysPipe: verbatimPipe };
}

function metaOf(key, fn, cls) {
  const own = Reflect.getMetadata(key, fn);
  return own !== undefined ? own : Reflect.getMetadata(key, cls);
}

/**
 * @returns {Array<{controller:string, handler:string, method:string, path:string, nestPath:string, prefixed:boolean,
 *   httpCode:number|undefined, flags:object, guards:string[], params:Array, rawResponse:boolean}>}
 */
export function enumerateRoutes(api = loadApi()) {
  const { modules, http, VerbatimKeysPipe } = api;
  const controllers = Reflect.getMetadata('controllers', modules.ApiModule) ?? [];
  const routes = [];
  for (const ctrl of controllers) {
    const base = Reflect.getMetadata('path', ctrl);
    const bases = Array.isArray(base) ? base : [base];
    const args = (k) => Reflect.getMetadata('__routeArguments__', ctrl, k) ?? {};
    for (const key of Object.getOwnPropertyNames(ctrl.prototype)) {
      if (key === 'constructor') continue;
      const fn = ctrl.prototype[key];
      if (typeof fn !== 'function') continue;
      const p = Reflect.getMetadata('path', fn);
      const m = Reflect.getMetadata('method', fn);
      if (p === undefined || m === undefined) continue;
      const paths = Array.isArray(p) ? p : [p];
      const guards = [...(Reflect.getMetadata('__guards__', ctrl) ?? []), ...(Reflect.getMetadata('__guards__', fn) ?? [])].map((g) => g?.name ?? String(g));
      const flags = {
        public: !!metaOf(META.public, fn, ctrl),
        userScoped: !!metaOf(META.userScoped, fn, ctrl),
        require: [...new Set([...(metaOf(META.require, fn, ctrl) ?? []), ...(metaOf(META.auditedRequire, fn, ctrl)?.permissions ?? [])])],
        allowPendingMfa: !!metaOf(META.allowPendingMfa, fn, ctrl),
        tokenAllowed: !!metaOf(META.tokenAllowed, fn, ctrl),
        recentAuth: !!metaOf(META.recentAuth, fn, ctrl),
      };
      const params = [];
      let rawResponse = false;
      const passthrough = !!Reflect.getMetadata('__responsePassthrough__', ctrl, key);
      for (const [k, v] of Object.entries(args(key))) {
        const [typePart] = k.split(':');
        const type = Number(typePart);
        const pipes = (v.pipes ?? []).map((pipe) => {
          const inst = typeof pipe === 'function' ? null : pipe;
          const name = (typeof pipe === 'function' ? pipe.name : pipe?.constructor?.name) ?? 'pipe';
          if (inst instanceof http.WirePipe) return { name, kind: 'wire', schema: inst.schema };
          if (VerbatimKeysPipe && inst instanceof VerbatimKeysPipe) return { name, kind: 'verbatim', schema: inst.schema, verbatim: [...inst.verbatim] };
          return { name, kind: 'other' };
        });
        if (Number.isNaN(type)) {
          params.push({ in: 'custom', index: v.index, data: v.data, pipes });
          continue;
        }
        if (type === PARAM.RESPONSE && !passthrough) rawResponse = true;
        const where = { [PARAM.BODY]: 'body', [PARAM.QUERY]: 'query', [PARAM.PARAM]: 'path', [PARAM.HEADERS]: 'header', [PARAM.REQUEST]: 'request', [PARAM.RESPONSE]: 'response', [PARAM.FILE]: 'file', [PARAM.FILES]: 'files', [PARAM.IP]: 'ip', [PARAM.RAW_BODY]: 'rawBody' }[type] ?? `type${type}`;
        params.push({ in: where, index: v.index, data: v.data, pipes });
      }
      params.sort((a, b) => a.index - b.index);
      for (const b of bases) {
        for (const sub of paths) {
          const nestPath = join(b, sub);
          const prefixed = !PREFIX_EXCLUDED.some((re) => re.test(nestPath));
          const full = '/' + (prefixed ? join('api/v1', nestPath) : nestPath);
          routes.push({
            controller: ctrl.name,
            handler: key,
            method: METHODS[m] ?? 'get',
            path: full.replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
            nestPath,
            prefixed,
            httpCode: Reflect.getMetadata('__httpCode__', fn),
            flags,
            guards,
            params,
            rawResponse,
            interceptors: (Reflect.getMetadata('__interceptors__', fn) ?? []).map((i) => i?.name ?? 'interceptor'),
          });
        }
      }
    }
  }
  routes.sort((a, b) => (a.path === b.path ? METHODS.indexOf(a.method) - METHODS.indexOf(b.method) : a.path < b.path ? -1 : 1));
  return routes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const routes = enumerateRoutes();
  for (const r of routes) {
    const ps = r.params.filter((p) => !['request', 'response', 'custom'].includes(p.in)).map((p) => `${p.in}${p.data ? `(${typeof p.data === 'object' ? JSON.stringify(p.data) : p.data})` : ''}${p.pipes.length ? `[${p.pipes.map((x) => x.kind).join(',')}]` : ''}`);
    const f = Object.entries(r.flags).filter(([, v]) => (Array.isArray(v) ? v.length : v)).map(([k, v]) => (Array.isArray(v) ? `${k}=${v.join('+')}` : k));
    console.log(`${r.method.toUpperCase().padEnd(6)} ${r.path.padEnd(58)} ${r.controller}.${r.handler} ${r.httpCode ?? ''} ${f.join(' ')} ${r.guards.join(',')} ${r.rawResponse ? 'RAW' : ''} ${ps.join(' ')} ${r.interceptors.join(',')}`);
  }
  console.log(routes.length, 'routes');
  process.exit(0);
}
