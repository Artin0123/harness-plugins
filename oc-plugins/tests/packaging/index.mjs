// Packaging guard for OpenCode plugins.
//
//   node oc-plugins/tests/packaging/index.mjs
//
// `opencode plugin add` fetches the package and then runs an npm install into
// ~/.cache/opencode/npm/<key>/<timestamp>/, so every dependency declared here is
// downloaded again on each add/update (npm auto-installs peers: a peer on
// @opencode/plugin measured 273 packages / 168 MB per install, v2.2.5).
//
// The rule these checks pin: no dependency fields, no runtime import of the host
// package (its `define` is identity and each plugin declares its own), and a
// default export of the shape the loader consumes (`{ id, setup }`).
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {existsSync, readFileSync} from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

let pass = 0; const failures = [];
const check = (name, ok, detail) => { if (ok) pass++; else failures.push(`${name} -> ${detail}`); };

// npm installs `dependencies` / `peerDependencies` / `optionalDependencies` of
// an installed package; devDependencies stay out. Any of the first three means
// a download the plugin does not need.
const FORBIDDEN_DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

for (const name of ['chat-trim-context', 'pwsh-profile-loader']) {
  const dir = join(root, name);
  const pkgPath = join(dir, 'package.json');
  const srcPath = join(dir, 'index.ts');

  check(`P[${name}]: package.json readable`, existsSync(pkgPath), pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  check(`P[${name}]: name is an opencode package`, /^opencode-/.test(pkg.name ?? ''), String(pkg.name));
  for (const field of FORBIDDEN_DEP_FIELDS) {
    check(`P[${name}]: no ${field}`, pkg[field] === undefined, JSON.stringify(pkg[field]));
  }

  check(`P[${name}]: main points at a real file`, existsSync(join(dir, pkg.main ?? '')), String(pkg.main));

  const src = readFileSync(srcPath, 'utf8');
  // `import type { ... }` is erased at load time and costs nothing; a value
  // import is what makes the host package a runtime dependency.
  const runtimeImport = /^\s*import\s+(?!type\s)[^;]*?from\s+["']@opencode\/plugin["']/m.test(src);
  check(`P[${name}]: no runtime import of @opencode/plugin`, !runtimeImport, 'index.ts imports the host package');
  check(`P[${name}]: declares define locally`, /const define = <T>\(plugin: T\): T => plugin/.test(src), 'define shim missing');

  const mod = await import(pathToFileURL(srcPath).href);
  const plugin = mod.default;
  check(`P[${name}]: default export is an object`, typeof plugin === 'object' && plugin !== null, typeof plugin);
  check(`P[${name}]: default export has a string id`, typeof plugin?.id === 'string' && plugin.id.length > 0, String(plugin?.id));
  check(`P[${name}]: default export has setup()`, typeof plugin?.setup === 'function', typeof plugin?.setup);
}

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== oc packaging battery: ${pass} passed, ${failures.length} failed ===`);
process.exit(failures.length === 0 ? 0 : 1);
