// Build gate: dist/loader.js runs as a classic script on customers' pages, so it must not declare any global of its
// own (the only globals it sets are window.Talkivio and the __talkivioLoaded guard, from inside its IIFE). Bundler
// helpers injected above the IIFE (e.g. esbuild's object-spread helpers when the target predates ES2018) would
// otherwise leak names like `Ee`, `D`, `le` into the host page. Runs the bundle in an empty VM context — there is
// no DOM there, so boot() stops early, but every top-level declaration has already been made.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const file = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/loader.js');
const context = vm.createContext({});
const globalsOf = () => Object.getOwnPropertyNames(vm.runInContext('globalThis', context));
const before = new Set(globalsOf());
try {
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: 'loader.js' });
} catch {
  /* expected without a DOM */
}
const leaked = globalsOf().filter((k) => !before.has(k));
if (leaked.length) {
  console.error(`✗ dist/loader.js declares globals on the host page: ${leaked.join(', ')}`);
  process.exit(1);
}
console.log('✓ dist/loader.js declares no globals outside its IIFE');
