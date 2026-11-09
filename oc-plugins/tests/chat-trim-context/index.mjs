// Behavior battery for the chat-trim-context plugin.
//
//   node oc-plugins/tests/chat-trim-context/index.mjs
//
// The test never runs OpenCode: it loads the ACTUAL plugin module (Node
// native TS type-stripping), runs setup() with a plugin environment that
// only records the registered hook callbacks, then calls each of the three
// callbacks directly with handmade events to pin the mutation behavior.
// The only source-text check pins the two env header sentences byte-exact.
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const moduleDir = join(here, '..', '..', 'chat-trim-context');

let pass = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) pass++; else failures.push(`${name} -> ${detail}`); };
const json = (v) => JSON.stringify(v);

const moduleSrc = readFileSync(join(moduleDir, 'index.ts'), 'utf8');

// ---------- source-text pins (env header sentences) ----------
check('L[src]: both env header sentences pinned byte-exact',
  moduleSrc.includes('Here is some useful information about the environment you are running in:')
  && moduleSrc.includes('The environment you are running in is now:'),
  'ENV_PARAGRAPHS');

// ---------- layer 1: drive the real module ----------
let mod = null;
const hooks = new Map();
const ctx = {session: {hook: (name, cb) => hooks.set(name, cb)}};
try {
  mod = await import(pathToFileURL(join(moduleDir, 'index.ts')).href);
  await mod.default.setup(ctx);
  check('L[hook]: registers context/compaction/generate',
    ['context', 'compaction', 'generate'].every((n) => typeof hooks.get(n) === 'function'),
    [...hooks.keys()].join(','));
} catch (error) {
  check('L[hook]: module loads and setup runs', false, String(error));
}

// Inert gate: a missing hook surface (older oc build, odd host) must neither
// throw nor register — the plugin simply stays out of the way.
try {
  await mod.default.setup({});
  await mod.default.setup({session: {}});
  check('L[setup]: missing hook surface is inert (no throw)', true, 'no throw');
} catch (error) {
  check('L[setup]: missing hook surface is inert (no throw)', false, String(error));
}

// ---------- behavior scenarios, run against ALL three hooks for parity ----------
const ENV_FIRST = 'Here is some useful information about the environment you are running in:\n<env>\n  Platform: win32\n  Is directory a git repo: yes\n</env>';
const ENV_CHANGED = 'The environment you are running in is now:\n<env>\n  Platform: win32\n</env>';

for (const name of ['context', 'compaction', 'generate']) {
  const cb = hooks.get(name);
  if (typeof cb !== 'function') continue; // registration check already failed

  // B1: env paragraphs removed wherever they sit; everything else verbatim.
  {
    const nonText = {type: 'other', data: 1};
    const e1 = {
      agent: 'chat',
      system: [
        {type: 'text', text: 'You are an agent for opencode.'},
        {type: 'text', text: ENV_FIRST + '\n\n# System\nBody text.'},
        {type: 'text', text: ENV_CHANGED},
        nonText,
        {type: 'text', text: 'A\n\n' + ENV_FIRST + '\n\nB'},
      ],
    };
    cb(e1);
    check(`B[${name}]: env paragraphs removed, system shrinks to 4 parts`,
      e1.system.length === 4, json(e1.system));
    check(`B[${name}]: part 0 exempt, preserved verbatim`,
      e1.system[0]?.text === 'You are an agent for opencode.', json(e1.system[0]));
    check(`B[${name}]: mixed part keeps non-env paragraphs verbatim`,
      e1.system[1]?.text === '# System\nBody text.', json(e1.system[1]));
    check(`B[${name}]: non-text part preserved as-is`,
      e1.system[2] === nonText, json(e1.system[2]));
    check(`B[${name}]: env paragraph in the middle removed, neighbors joined`,
      e1.system[3]?.text === 'A\n\nB', json(e1.system[3]));
  }
  // B2: a part consisting solely of the env block is dropped entirely.
  {
    const e2 = {agent: 'chat', system: [{type: 'text', text: 'keep'}, {type: 'text', text: ENV_CHANGED}]};
    cb(e2);
    check(`B[${name}]: env-only part dropped entirely`,
      e2.system.length === 1 && e2.system[0].text === 'keep', json(e2.system));
  }
  // B3: env block + whitespace-only tail cleans to empty -> part dropped
  // (index >= 1; index 0 is exempt by design).
  {
    const e3 = {agent: 'chat', system: [{type: 'text', text: 'keep'}, {type: 'text', text: ENV_CHANGED + '\n\n   '}]};
    cb(e3);
    check(`B[${name}]: env-only part with whitespace tail dropped`,
      e3.system.length === 1 && e3.system[0].text === 'keep', json(e3.system));
  }
  // B4: non-chat agents are untouched, byte-for-byte.
  {
    const e4 = {agent: 'build', system: [{type: 'text', text: ENV_FIRST}, {type: 'other', data: 1}]};
    const before = json(e4.system);
    cb(e4);
    check(`B[${name}]: non-chat agent untouched`, json(e4.system) === before, json(e4.system));
  }
  // B5: no env paragraphs -> texts pass through verbatim.
  {
    const e5 = {agent: 'chat', system: [{type: 'text', text: 'a  \n\n  b'}]};
    cb(e5);
    check(`B[${name}]: no env -> texts verbatim`,
      e5.system.length === 1 && e5.system[0].text === 'a  \n\n  b', json(e5.system));
  }
}

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== oc chat-trim-context battery: ${pass} passed, ${failures.length} failed ===`);
process.exit(failures.length === 0 ? 0 : 1);
