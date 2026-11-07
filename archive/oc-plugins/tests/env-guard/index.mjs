// Unit battery for oc-plugins/env-guard/index.ts (2026-11-05 redesign)
//
//   node oc-plugins/tests/env-guard/index.mjs
//
// Imports the plugin's TypeScript directly (type stripping, no build step)
// and asserts: every closed-set temp-path guard on all four surfaces, the
// hook wiring, and the boundary cases that must NOT change anything.
// The input-side bash scanner was removed in the redesign: the shell hook's
// `command` is pinned to NEVER be rewritten (single assertion covering the
// whole former scanner surface).
//
// Expected values use os.tmpdir(); the plugin's anchor is `cygpath -w /tmp`
// from the detected bash. On this machine both resolve to the same Windows
// temp dir, so the two can be compared directly.
//
// Needs Node >= 22.6 (type stripping default from 23.6).
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const selfPath = fileURLToPath(import.meta.url);
// The plugin needs no host package at load time (its `define` is declared in
// the source), so the battery imports the source verbatim -- from a throwaway
// copy in the system temp dir, so nothing is written into the repo. The
// --noanchor worker reuses this scratch via EG_SCRATCH (its scrubbed env makes
// mkdtempSync itself impossible, so the parent provides the dir).
const srcPath = join(here, '..', '..', 'env-guard', 'index.ts');
const src = readFileSync(srcPath, 'utf8');
if (/from\s+["']@opencode\/plugin["']/.test(src)) {
  // A runtime import of the host package makes npm auto-install the peer and
  // pull in 273 packages / 168 MB per install (measured, v2.2.5).
  throw new Error('env-guard/index.ts must not import @opencode/plugin at runtime');
}
// redesign pin: the scanner must be gone, not commented out
if (/scanBash|matchParen|readHeredocHead|rewriteBashCommand|convertEnvPath/.test(src)) {
  throw new Error('redesign regression: input-side bash scanner symbols must not exist');
}
const scratch = process.env.EG_SCRATCH ?? mkdtempSync(join(tmpdir(), 'env-guard-oc-'));
const loadPath = join(scratch, 'index.ts');
writeFileSync(loadPath, src, 'utf8');
const mod = await import(pathToFileURL(loadPath).href);

// Worker mode (own process: module-level caches pin each scenario): runs
// with a scrubbed environment (PATH without any MSYS bash, fake program
// roots, a non-drive TEMP) and reports what the plugin does without an
// anchor -- it must go inert, never guess a layout.
if (process.argv.includes('--noanchor')) {
  console.log(JSON.stringify({ temp: mod.realTempDir(), path: mod.rewritePath('/tmp/x') }));
  process.exit(0);
}

let pass = 0; const failures = [];
const check = (name, ok, detail) => { if (ok) pass++; else failures.push(`${name} -> ${detail}`); };
const rt = (p) => mod.rewritePath(p);
const T = tmpdir();
const N = T.endsWith('\\') ? T : T + '\\';

// --- rewritePath: /tmp family ---
check('P: /tmp bare', rt('/tmp') === T, JSON.stringify(rt('/tmp')));
check('P: /tmp/x', rt('/tmp/sub/x.txt') === N + 'sub\\x.txt', JSON.stringify(rt('/tmp/sub/x.txt')));
check('P: /TMP case-insensitive', rt('/TMP/x') === N + 'x', JSON.stringify(rt('/TMP/x')));
check('P: /tmp\\foo mixed separator', rt('/tmp\\foo') === N + 'foo', JSON.stringify(rt('/tmp\\foo')));
check('P: $TEMP/x', rt('$TEMP/x') === N + 'x', JSON.stringify(rt('$TEMP/x')));
check('P: $temp lowercase', rt('$temp/x') === N + 'x', JSON.stringify(rt('$temp/x')));
check('P: $TMP/x', rt('$TMP/x') === N + 'x', JSON.stringify(rt('$TMP/x')));
check('P: $TMPDIR/x', rt('$TMPDIR/x') === N + 'x', JSON.stringify(rt('$TMPDIR/x')));
check('P: bare $TEMP', rt('$TEMP') === T, JSON.stringify(rt('$TEMP')));
check('P: %TEMP%/x', rt('%TEMP%/x') === N + 'x', JSON.stringify(rt('%TEMP%/x')));
check('P: %tmp%\\x', rt('%tmp%\\x') === N + 'x', JSON.stringify(rt('%tmp%\\x')));
check('P: ${TEMP}/x braced', rt('${TEMP}/x') === N + 'x', JSON.stringify(rt('${TEMP}/x')));
check('P: ${tmpdir} bare braced', rt('${tmpdir}') === T, JSON.stringify(rt('${tmpdir}')));
check('P: trailing separator trimmed', rt('/tmp/') === T, JSON.stringify(rt('/tmp/')));
check('P: /tmp\\ trailing trimmed', rt('/tmp\\') === T, JSON.stringify(rt('/tmp\\')));

// --- rewritePath: deliberate non-fixes ---
check('P: C:\\tmp untouched (native write ok)', rt('C:\\tmp\\x') === 'C:\\tmp\\x', JSON.stringify(rt('C:\\tmp\\x')));
check('P: relative untouched', rt('relative/x') === 'relative/x', JSON.stringify(rt('relative/x')));
check('P: ~ untouched (tool expands)', rt('~/x') === '~/x', JSON.stringify(rt('~/x')));

// --- rewritePath: MSYS drive letters — deliberately NOT fixed ---
// OpenCode's tool layer resolves /c/Users/x -> C:\Users\x natively (measured
// e2e). A rewrite here would be duplicate protection (pure side effect).
check('P: /c/Users passes through (host maps natively)', rt('/c/Users/a') === '/c/Users/a', JSON.stringify(rt('/c/Users/a')));
check('P: /c/tmp passes through', rt('/c/tmp/x') === '/c/tmp/x', JSON.stringify(rt('/c/tmp/x')));
// prefix boundaries: a temp-looking name that is not the temp dir stays put
check('P: $TEMPFILE/x untouched', rt('$TEMPFILE/x') === '$TEMPFILE/x', JSON.stringify(rt('$TEMPFILE/x')));
check('P: $TMPDIRX/x untouched', rt('$TMPDIRX/x') === '$TMPDIRX/x', JSON.stringify(rt('$TMPDIRX/x')));
check('P: /tmpfoo/x untouched', rt('/tmpfoo/x') === '/tmpfoo/x', JSON.stringify(rt('/tmpfoo/x')));
check('P: //server/share untouched', rt('//server/share') === '//server/share', JSON.stringify(rt('//server/share')));
check('P: bare %TEMP%', rt('%TEMP%') === T, JSON.stringify(rt('%TEMP%')));

// --- patch text: only directive lines are paths ---
const patchAdd = mod.rewritePatchText('*** Begin Patch\n*** Add File: ${TEMP}/p.txt\n+hello\n*** End Patch');
check('P: patch Add File rewritten', patchAdd.includes('*** Add File: ' + N + 'p.txt'), JSON.stringify(patchAdd));
const patchUpd = mod.rewritePatchText('*** Update File: /tmp/u.txt\r\n@@\r\n-old\r\n+new\r\n');
check('P: patch Update File rewritten, CRLF kept', patchUpd.startsWith('*** Update File: ' + N + 'u.txt\r\n'), JSON.stringify(patchUpd));
const patchMove = mod.rewritePatchText('*** Update File: /tmp/a.txt\n*** Move to: ${TMPDIR}/b.txt\n');
check('P: patch Move to rewritten', patchMove.includes('*** Move to: ' + N + 'b.txt'), JSON.stringify(patchMove));
const patchDel = mod.rewritePatchText('*** Delete File: %TEMP%/d.txt\n');
check('P: patch Delete File rewritten', patchDel === '*** Delete File: ' + N + 'd.txt\n', JSON.stringify(patchDel));
const patchContent = mod.rewritePatchText('*** Add File: /tmp/c.txt\n+*** Add File: /tmp/not-a-path.txt\n+*** Move to: /tmp/nope\n');
check('P: patch content lines untouched', patchContent.includes('+*** Add File: /tmp/not-a-path.txt') && patchContent.includes('+*** Move to: /tmp/nope'), JSON.stringify(patchContent));
const patchKeep = mod.rewritePatchText('*** Add File: src/x.ts\n+a\n');
check('P: patch non-temp path untouched', patchKeep === '*** Add File: src/x.ts\n+a\n', JSON.stringify(patchKeep));

// --- glob: temp prefix inside the pattern moves into path ---
const split = (p) => mod.splitTempPrefix(p);
const gp = split('${TEMP}/*.txt');
check('P: glob ${TEMP}/*.txt splits', !!gp && gp.dir === T && gp.rest === '*.txt', JSON.stringify(gp));
const gp2 = split('/tmp/**/*.log');
check('P: glob /tmp/**/*.log splits', !!gp2 && gp2.rest === '**/*.log', JSON.stringify(gp2));
const gp3 = split('$TMP/a\\b.txt');
check('P: glob $TMP backslash splits', !!gp3 && gp3.rest === 'a/b.txt', JSON.stringify(gp3));
check('P: glob unrelated pattern untouched', split('src/**/*.ts') === null, JSON.stringify(split('src/**/*.ts')));
check('P: glob bare $TEMP untouched', split('$TEMP') === null, JSON.stringify(split('$TEMP')));

// --- temp mechanism classification is the SAME source as the rewrite ------
const cls = (p) => mod.classifyTempPath(p);
check('S: /tmp classified as tempMount', cls('/tmp/x') === 'tempMount', String(cls('/tmp/x')));
check('S: /TMP classified as tempMount (case-insensitive)', cls('/TMP') === 'tempMount', String(cls('/TMP')));
check('S: $TEMP classified as tempVar', cls('$TEMP/x') === 'tempVar', String(cls('$TEMP/x')));
check('S: ${TMPDIR} classified as tempVar', cls('${TMPDIR}/x') === 'tempVar', String(cls('${TMPDIR}/x')));
check('S: %TMP% classified as tempVar', cls('%TMP%\\x') === 'tempVar', String(cls('%TMP%\\x')));
check('S: /tmpfoo is not a temp dir', cls('/tmpfoo/x') === null, String(cls('/tmpfoo/x')));
check('S: $TEMPFILE is not a temp var', cls('$TEMPFILE/x') === null, String(cls('$TEMPFILE/x')));
const rvf = mod.rewritePathFix('/tmp/x');
check('S: rewritePathFix returns value + mechanism together',
  rvf.value === N + 'x' && rvf.mechanism === 'tempMount', JSON.stringify(rvf));
const rvfNone = mod.rewritePathFix('plain.txt');
check('S: rewritePathFix reports no mechanism for a non-temp path',
  rvfNone.value === 'plain.txt' && rvfNone.mechanism === null, JSON.stringify(rvfNone));
const pf = mod.rewritePatchTextFix('*** Add File: ${TEMP}/x\n*** Add File: /tmp/y\n');
check('S: one patch reports both mechanisms it rewrote',
  pf.mechanisms.length === 2 && pf.mechanisms.includes('tempVar') && pf.mechanisms.includes('tempMount'),
  JSON.stringify(pf.mechanisms));
const gpMount = split('/tmp/*.txt');
check('S: glob prefix reports its mechanism', !!gpMount && gpMount.mechanism === 'tempMount', JSON.stringify(gpMount));
const gpVar = split('${TEMP}/*.txt');
check('S: glob var prefix reports tempVar', !!gpVar && gpVar.mechanism === 'tempVar', JSON.stringify(gpVar));

// --- bash detection sanity (this machine must find its own MSYS bash) ---
const bash = mod.findBash();
check('P: findBash finds an MSYS bash on this machine', !!bash, String(bash));

// --- temp anchor contract ---
const anchor = mod.realTempDir();
check('P: temp anchor is a drive path equal to tmpdir()',
  typeof anchor === 'string' && /^[A-Za-z]:[\\/]/.test(anchor) && anchor === normalize(tmpdir()),
  JSON.stringify(anchor));

// --- shell identity gate ---
if (bash) check('P: the detected bash is a verified MSYS shell', mod.isMsysShell(bash), bash);
check('P: a non-shell executable is not MSYS', mod.isMsysShell(process.execPath) === false, process.execPath);

// --- no measured anchor -> inert (worker process, scrubbed environment) ---
const noAnchor = JSON.parse(
  spawnSync(process.execPath, [selfPath, '--noanchor'], {
    env: {
      ...process.env,
      EG_SCRATCH: scratch,
      PATH: 'C:\\Windows\\system32',
      ProgramFiles: 'C:\\nope',
      'ProgramFiles(x86)': 'C:\\nope',
      LOCALAPPDATA: 'C:\\nope',
      TEMP: '\\\\tmp',
      TMP: '\\\\tmp',
    },
    encoding: 'utf8',
  }).stdout.trim(),
);
check('P: no anchor -> temp is null (no layout guess)', noAnchor.temp === null, JSON.stringify(noAnchor));
check('P: no anchor -> /tmp untouched', noAnchor.path === '/tmp/x', JSON.stringify(noAnchor));

// --- non-win32: /tmp and $TEMP are native semantics elsewhere; nothing may
// fire and no hook may register (the platform check is at call/setup time) ---
const realPlatform = process.platform;
let unixPath, unixSplit;
let unixHooks = 0;
const linuxCtx = {
  tool: { hook: () => { unixHooks++; return Promise.resolve({ dispose: async () => {} }); } },
  shell: { hook: () => { unixHooks++; return Promise.resolve({ dispose: async () => {} }); } },
};
try {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  unixPath = rt('/tmp/x');
  unixSplit = split('/tmp/*.txt');
  await mod.default.setup(linuxCtx);
} finally {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
}
check('P: non-win32 leaves /tmp untouched', unixPath === '/tmp/x', JSON.stringify(unixPath));
check('P: non-win32 leaves the glob pattern alone', unixSplit === null, JSON.stringify(unixSplit));
check('P: non-win32 registers no hooks', unixHooks === 0, String(unixHooks));

// ===========================================================================
// hook wiring (fake ctx): two domains -- tool.execute.before (temp paths),
// shell.create.before (workdir ONLY: the redesign removes every command
// rewrite)
// ===========================================================================
const hooks = {};
const fakeCtx = {
  tool: { hook: (name, cb) => { (hooks['tool:' + name] ??= []).push(cb); return Promise.resolve({ dispose: async () => {} }); } },
  shell: { hook: (name, cb) => { (hooks['shell:' + name] ??= []).push(cb); return Promise.resolve({ dispose: async () => {} }); } },
};
await mod.default.setup(fakeCtx);
const toolBefore = hooks['tool:execute.before']?.[0];
const shellBefore = hooks['shell:create.before']?.[0];
check('H: setup registers all hook names',
  !!toolBefore && !!shellBefore, Object.keys(hooks).join(','));

// --- tool execute.before (temp paths) ---
const evNoTool = { input: { path: '/tmp/x' } };
let noToolThrew = false;
try { toolBefore(evNoTool); } catch { noToolThrew = true; }
check('H: missing tool name fails safe (no throw, no rewrite)',
  !noToolThrew && evNoTool.input.path === '/tmp/x', JSON.stringify({ noToolThrew, path: evNoTool.input.path }));

const evPath = (tool, p) => ({ tool, input: { path: p } });
const p1 = evPath('write', '/tmp/e2e.txt'); toolBefore(p1);
check('H: tool hook rewrites input.path', p1.input.path === N + 'e2e.txt', JSON.stringify(p1.input));
const p2 = evPath('read', 'C:\\tmp\\x'); toolBefore(p2);
check('H: hook keeps deliberate non-fix', p2.input.path === 'C:\\tmp\\x', JSON.stringify(p2.input));
const p3 = evPath('bash', '/tmp/x'); toolBefore(p3);
check('H: hook ignores non-path tool', p3.input.path === '/tmp/x', JSON.stringify(p3.input));
const p4 = { tool: 'glob', input: { pattern: '/tmp/*.txt' } };
toolBefore(p4);
check('H: glob pattern prefix becomes path', p4.input.pattern === '*.txt' && p4.input.path === T, JSON.stringify(p4.input));
const p5 = { tool: 'glob', input: { pattern: '${TEMP}/*.txt', path: 'src' } };
toolBefore(p5);
check('H: glob with explicit path left alone', p5.input.pattern === '${TEMP}/*.txt' && p5.input.path === 'src', JSON.stringify(p5.input));
const p6 = { tool: 'patch', input: { patchText: '*** Add File: /tmp/z.txt\n+x\n' } };
toolBefore(p6);
check('H: patch text rewritten', p6.input.patchText.includes(N + 'z.txt'), JSON.stringify(p6.input));

// --- shell create.before: workdir only; command NEVER rewritten ----------
// (redesign pin: one assertion covers the whole former scanner surface --
// heredoc bodies, data positions, assignments... nothing is a rewrite target
// any more, so the pin is literally "command verbatim, always")
const evShell = (command, shell, cwd = '') => ({ command, cwd, timeout: 0, shell, env: {} });
{
  const commands = [
    'cmd //c ver',
    'echo cmd //c ver',
    "cat <<'EOF'\ncmd //c ver\nEOF",
    'A=/c/x node x',
    'echo $(case b in a) x;; esac) cmd //c ver',
    '"cmd" //c ver',
    'cmd > //out',
  ];
  for (const c of commands) {
    const ev = evShell(c, bash); shellBefore(ev);
    check('H: shell hook leaves command verbatim (no scanner): ' + JSON.stringify(c),
      ev.command === c, JSON.stringify(ev.command));
  }
}
const s5 = evShell('pwd', bash, '/tmp'); shellBefore(s5);
check('H: shell hook rewrites workdir /tmp', s5.cwd === T, JSON.stringify(s5.cwd));
const s6 = evShell('pwd', bash, '$TEMP'); shellBefore(s6);
check('H: shell hook rewrites workdir $TEMP', s6.cwd === T, JSON.stringify(s6.cwd));
const s7 = evShell('pwd', bash, 'C:\\tmp'); shellBefore(s7);
check('H: shell hook keeps workdir C:\\tmp', s7.cwd === 'C:\\tmp', JSON.stringify(s7.cwd));
const s8 = evShell('pwd', process.execPath, '/tmp'); shellBefore(s8);
check('H: shell hook keeps workdir for non-bash', s8.cwd === '/tmp', JSON.stringify(s8.cwd));
check('H: non-bash shell never reaches the command/workdir decisions', s8.command === 'pwd', JSON.stringify(s8.command));

// defensive string-contract guards (contract parity, no measured fault)
const hxU = evShell(undefined, bash, '/tmp');
let hxThrew = false;
try { shellBefore(hxU); } catch { hxThrew = true; }
check('H: non-string command -> no throw, command untouched, workdir still rewritten',
  !hxThrew && hxU.command === undefined && hxU.cwd === T, JSON.stringify({ hxThrew, command: hxU.command, cwd: hxU.cwd }));
const hxD = evShell(42, bash); hxThrew = false;
try { shellBefore(hxD); } catch { hxThrew = true; }
check('H: numeric command -> no throw, untouched', !hxThrew && hxD.command === 42, JSON.stringify({ hxThrew, command: hxD.command }));
const hxS = evShell('cmd //c ver', 42); hxThrew = false;
try { shellBefore(hxS); } catch { hxThrew = true; }
check('H: numeric shell -> no throw, no bump, command untouched',
  !hxThrew && hxS.command === 'cmd //c ver' && hxS.cwd === '', JSON.stringify({ hxThrew, command: hxS.command }));

// ===========================================================================
// usage telemetry: denominators post-gate, numerators per fix key
// ===========================================================================
const savedSets = [];
const mkStatsCtx = (saved, broken = false) => {
  const h = {};
  let current = saved; // a storage that reflects its own writes
  const ctx = {
    tool: { hook: (name, cb) => { h['tool:' + name] = cb; return Promise.resolve({ dispose: async () => {} }); } },
    shell: { hook: (name, cb) => { h['shell:' + name] = cb; return Promise.resolve({ dispose: async () => {} }); } },
    storage: {
      get: async () => { if (broken) throw new Error('db down'); return current; },
      set: async (k, v) => { await new Promise((r) => setTimeout(r, 5)); if (broken) throw new Error('db down'); savedSets.push(v); current = v; },
    },
  };
  return { h, ctx };
};

const A = mkStatsCtx(undefined);
const cleanupA = await mod.default.setup(A.ctx);
const tA = A.h['tool:execute.before'];
const sA = A.h['shell:create.before'];
check('S: setup registers all hooks', !!tA && !!sA, Object.keys(A.h).join(','));

await tA({ tool: 'read', input: { path: '/tmp/x' } });
await tA({ tool: 'read', input: { path: '$TEMP/x' } });
await tA({ tool: 'read', input: { path: 'plain.txt' } });
await tA({ tool: 'webfetch', input: {} }); // outside the guard list: no denominator
await tA({ tool: 'glob', input: { pattern: '${TEMP}/*.txt' } });
await tA({ tool: 'glob', input: { pattern: '/tmp/*.log' } });
await tA({ tool: 'patch', input: { patchText: '*** Add File: ${TEMP}/x\n' } });
await tA({ tool: 'patch', input: { patchText: '*** Add File: /tmp/y\n' } });
await sA({ shell: bash, cwd: '/tmp/sub', command: 'echo hi' }); // MSYS shell: bash denominator
await sA({ shell: process.execPath, cwd: '/tmp/sub', command: 'cmd //c ver' }); // non-MSYS shell: skipped
await sA({ shell: bash, cwd: '/tmp/sub', command: 'cmd //c ver' }); // command verbatim, denominator only
await sA({ shell: bash, cwd: '$TEMP/sub', command: 'echo hi' }); // var-mechanism workdir

const snapA = mod.statsSnapshot();
check('S: denominators (read 3, glob 2, patch 2, bash 3)',
  snapA.toolCalls.read === 3 && snapA.toolCalls.glob === 2 && snapA.toolCalls.patch === 2 && snapA.toolCalls.bash === 3,
  JSON.stringify(snapA.toolCalls));
check('S: unguarded tool not counted', snapA.toolCalls.webfetch === undefined, JSON.stringify(snapA.toolCalls));
check('S: non-MSYS shell does not bump bash', snapA.toolCalls.bash === 3, JSON.stringify(snapA.toolCalls));
check('S: path.tempMount numerator', snapA.fixes['path.tempMount'] === 1, JSON.stringify(snapA.fixes));
check('S: path.tempVar numerator', snapA.fixes['path.tempVar'] === 1, JSON.stringify(snapA.fixes));
check('S: glob.tempVar numerator', snapA.fixes['glob.tempVar'] === 1, JSON.stringify(snapA.fixes));
check('S: glob.tempMount numerator', snapA.fixes['glob.tempMount'] === 1, JSON.stringify(snapA.fixes));
check('S: patch.tempVar numerator', snapA.fixes['patch.tempVar'] === 1, JSON.stringify(snapA.fixes));
check('S: patch.tempMount numerator', snapA.fixes['patch.tempMount'] === 1, JSON.stringify(snapA.fixes));
check('S: shell.workdir.tempMount numerator (one per MSYS shell event)',
  snapA.fixes['shell.workdir.tempMount'] === 2, JSON.stringify(snapA.fixes));
check('S: shell.workdir.tempVar numerator', snapA.fixes['shell.workdir.tempVar'] === 1, JSON.stringify(snapA.fixes));
check('S: commands are never rewritten -> no cmdFlag/envPath numerators any more',
  snapA.fixes['shell.cmdFlag'] === undefined && snapA.fixes['shell.envPath'] === undefined,
  JSON.stringify(snapA.fixes));

await cleanupA(); // the returned promise must cover the final write
check('S: awaited cleanup flush persists', savedSets.length >= 1, JSON.stringify(savedSets.length));
const persisted = savedSets[savedSets.length - 1] ?? null;
check('S: persisted value matches the snapshot',
  persisted && persisted.schema === 1 &&
  persisted.toolCalls.read === snapA.toolCalls.read &&
  persisted.fixes['path.tempMount'] === snapA.fixes['path.tempMount'],
  JSON.stringify(persisted));

// reload adopts what was persisted (history survives a restart)
const B = mkStatsCtx(persisted);
const cleanupB = await mod.default.setup(B.ctx);
const snapB = mod.statsSnapshot();
check('S: reload adopts prior counts',
  snapB.toolCalls.read === snapA.toolCalls.read && snapB.fixes['path.tempMount'] === snapA.fixes['path.tempMount'],
  JSON.stringify(snapB));
check('S: reload keeps the original since', snapB.since === persisted?.since, JSON.stringify(snapB.since));
await B.h['tool:execute.before']({ tool: 'read', input: { path: '/tmp/y' } });
await cleanupB();
check('S: second run adds on top (read-modify-write)',
  savedSets[savedSets.length - 1]?.toolCalls.read === snapA.toolCalls.read + 1,
  JSON.stringify(savedSets[savedSets.length - 1]));

// a call that changes nothing must not bump ANY fix key
const Z = mkStatsCtx(undefined);
const cleanupZ = await mod.default.setup(Z.ctx);
await Z.h['tool:execute.before']({ tool: 'read', input: { path: 'plain.txt' } });
await Z.h['shell:create.before']({ shell: bash, cwd: 'C:\\tmp', command: 'echo hi' });
const snapZ = mod.statsSnapshot();
check('S: no rewrite -> no numerator (only tool calls)',
  snapZ.toolCalls.read === 1 && snapZ.toolCalls.bash === 1 && Object.keys(snapZ.fixes).length === 0,
  JSON.stringify({ toolCalls: snapZ.toolCalls, fixes: snapZ.fixes }));
await cleanupZ();

// legacy keys in an existing store: historical total are never renamed
const L = mkStatsCtx({ schema: 1, since: 'SINCE-L', toolCalls: {}, fixes: { 'path.temp': 3, 'shell.cmdFlag': 9, 'shell.envPath': 2 } });
const cleanupL = await mod.default.setup(L.ctx);
await L.h['tool:execute.before']({ tool: 'read', input: { path: '/tmp/legacy' } });
const snapL = mod.statsSnapshot();
check('S: legacy keys kept untouched',
  snapL.fixes['path.temp'] === 3 && snapL.fixes['shell.cmdFlag'] === 9 && snapL.fixes['shell.envPath'] === 2,
  JSON.stringify(snapL.fixes));
check('S: new count goes to the split key (path.tempMount)', snapL.fixes['path.tempMount'] === 1, JSON.stringify(snapL.fixes));
await cleanupL();

// malformed saved data: shape-checked and coerced, never fatal
const C = mkStatsCtx({ schema: 1, since: 'SINCE', toolCalls: { read: '5', bad: -1 }, fixes: 'nope' });
const cleanupC = await mod.default.setup(C.ctx);
const snapC = mod.statsSnapshot();
check('S: malformed counts coerced/dropped',
  snapC.toolCalls.read === 5 && snapC.toolCalls.bad === undefined && Object.keys(snapC.fixes).length === 0,
  JSON.stringify(snapC));
check('S: malformed data keeps since', snapC.since === 'SINCE', JSON.stringify(snapC.since));
await cleanupC();

// broken storage: counting continues in memory, hooks still register,
// cleanup survives the failed flush
const D = mkStatsCtx(undefined, true);
const cleanupD = await mod.default.setup(D.ctx);
check('S: broken storage still registers hooks', !!D.h['tool:execute.before'], Object.keys(D.h).join(','));
await D.h['tool:execute.before']({ tool: 'read', input: { path: '/tmp/z' } });
check('S: in-memory counting survives a broken storage', mod.statsSnapshot().toolCalls.read === 1, JSON.stringify(mod.statsSnapshot().toolCalls));
await cleanupD(); // must not throw
check('S: cleanup with broken storage does not throw', true, '');

// --- concurrent servers: flush re-reads the store and adds only our delta --
const sharedStore = { value: undefined };
const mkSharedCtx = () => {
  const h = {};
  const ctx = {
    tool: { hook: (name, cb) => { h['tool:' + name] = cb; return Promise.resolve({ dispose: async () => {} }); } },
    shell: { hook: (name, cb) => { h['shell:' + name] = cb; return Promise.resolve({ dispose: async () => {} }); } },
    storage: {
      get: async () => sharedStore.value,
      set: async (k, v) => { sharedStore.value = v; },
    },
  };
  return { h, ctx };
};
const mod2Path = join(scratch, 'index-two.ts');
writeFileSync(mod2Path, src, 'utf8');
const mod2 = await import(pathToFileURL(mod2Path).href);
const run1 = mkSharedCtx(); const run2 = mkSharedCtx();
const clean1 = await mod.default.setup(run1.ctx);
const clean2 = await mod2.default.setup(run2.ctx); // run2 loads BEFORE run1 writes
await run1.h['tool:execute.before']({ tool: 'read', input: { path: '/tmp/p1' } });
await clean1();
check('S: first server flush lands its count', sharedStore.value?.toolCalls?.read === 1, JSON.stringify(sharedStore.value));
await run2.h['tool:execute.before']({ tool: 'read', input: { path: '/tmp/p2' } });
await clean2();
check('S: concurrent flush keeps the other server write (delta merge)',
  sharedStore.value?.toolCalls?.read === 2, JSON.stringify(sharedStore.value));
await clean2();
check('S: re-based flush is idempotent', sharedStore.value?.toolCalls?.read === 2, JSON.stringify(sharedStore.value));
await run2.h['tool:execute.before']({ tool: 'read', input: { path: '/tmp/p2b' } });
await clean2();
check('S: increments after the merge base on the new baseline',
  sharedStore.value?.toolCalls?.read === 3, JSON.stringify(sharedStore.value));

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== oc unit battery: ${pass} passed, ${failures.length} failed ===`);
rmSync(scratch, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
