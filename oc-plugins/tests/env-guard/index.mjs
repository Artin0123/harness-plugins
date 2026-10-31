// Unit battery for oc-plugins/env-guard/index.ts
//
//   node oc-plugins/tests/env-guard/index.mjs
//
// Imports the plugin's TypeScript directly (type stripping, no build step)
// and asserts every documented guard plus every deliberately-not-fixed form,
// so the "刻意不修" decisions stay pinned instead of drifting back.
// Run from a shell whose TEMP is a real Windows path (cmd / powershell /
// non-bash): assertions compare against os.tmpdir() as the fallback anchor,
// while the plugin's primary anchor is `cygpath -w /tmp` from the detected
// bash -- the two agree on this machine only when TEMP is a Windows path.
//
// Needs Node >= 22.6 (type stripping default from 23.6).
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir as _tt} from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
// The plugin imports `Plugin` from @opencode/plugin (a runtime dep only the
// host resolves). The unit battery targets the exported pure functions, so
// the import is swapped for a passthrough stub and the source is imported
// from a throwaway copy in the system temp dir (nothing added to the repo).
const srcPath = join(here, '..', '..', 'env-guard', 'index.ts');
const src = readFileSync(srcPath, 'utf8')
  .replace('import { Plugin } from "@opencode/plugin"', 'const Plugin = { define: (p) => p };');
const scratch = mkdtempSync(join(_tt(), 'env-guard-oc-'));
const loadPath = join(scratch, 'index.ts');
writeFileSync(loadPath, src, 'utf8');
const mod = await import(pathToFileURL(loadPath).href);

let pass = 0; const failures = [];
const check = (name, ok, detail) => { if (ok) pass++; else failures.push(`${name} -> ${detail}`); };
const rt = (p) => mod.rewritePath(p);
const bc = (c) => mod.rewriteBashCommand(c);
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

// --- rewritePath: deliberate non-fixes ---
check('P: C:\\tmp untouched (native write ok)', rt('C:\\tmp\\x') === 'C:\\tmp\\x', JSON.stringify(rt('C:\\tmp\\x')));
check('P: relative untouched', rt('relative/x') === 'relative/x', JSON.stringify(rt('relative/x')));
check('P: ~ untouched (tool expands)', rt('~/x') === '~/x', JSON.stringify(rt('~/x')));

// --- rewritePath: MSYS drive letters — deliberately NOT fixed ---
// OpenCode's tool layer resolves /c/Users/x -> C:\Users\x natively (measured
// e2e: read /c/Users/... hit the real file). A rewrite here would be
// duplicate protection (pure side effect).
check('P: /c/Users passes through (host maps natively)', rt('/c/Users/a') === '/c/Users/a', JSON.stringify(rt('/c/Users/a')));
check('P: /c/tmp passes through', rt('/c/tmp/x') === '/c/tmp/x', JSON.stringify(rt('/c/tmp/x')));

// --- rewriteBashCommand: doubled flags (probe-gated: fires only when the
// spawned bash actually reports MSYS_NO_PATHCONV=1; on a machine without the
// bashrc setting, or when the probe fails, these MUST NOT rewrite) ---
const noConv = bc('cmd //c ver');
check('P: cmd //c -> /c', noConv.command === 'cmd /c ver' && noConv.cmdFlagFixed, JSON.stringify(noConv));
check('P: cmd //k -> /k', bc('cmd //k dir').cmdFlagFixed, JSON.stringify(bc('cmd //k dir')));
const multi = bc('cmd //q //c ver');
check('P: multi-flag //q //c both fixed', multi.command === 'cmd /q /c ver', JSON.stringify(multi));
const tight = bc('cmd//c ver');
check('P: tight cmd//c form', tight.command === 'cmd /c ver', JSON.stringify(tight));
const tightInSeq = bc('FOO=1 cmd//c ver');
check('P: tight form after env prefix', tightInSeq.command === 'FOO=1 cmd /c ver', JSON.stringify(tightInSeq));

// --- rewriteBashCommand: position awareness ---
check('P: data position untouched', bc('echo cmd //c ver').command === 'echo cmd //c ver', JSON.stringify(bc('echo cmd //c ver')));
const afterSemi = bc('ls; cmd //c ver');
check('P: command position after ; fixed', afterSemi.command === 'ls; cmd /c ver', JSON.stringify(afterSemi));
const nested = bc('echo "v: $(cmd //c ver)"');
check('P: nested $( ) fixed', nested.command === 'echo "v: $(cmd /c ver)"', JSON.stringify(nested));
const backtick = bc('echo v: `cmd //c ver`');
check('P: backtick nested fixed', backtick.command === 'echo v: `cmd /c ver`', JSON.stringify(backtick));
const dqVar = bc('echo "$V"');
check('P: plain double-quote var untouched', dqVar.command === 'echo "$V"', JSON.stringify(dqVar));
const redirect = bc('cmd //c ver > out.txt');
check('P: redirect target not command position', redirect.command === 'cmd /c ver > out.txt', JSON.stringify(redirect));
const twoAh = bc('cmd //c ver 2>&1');
check('P: 2>&1 survives', twoAh.command === 'cmd /c ver 2>&1', JSON.stringify(twoAh));

// --- rewriteBashCommand: protected data ---
const heredoc = bc("cat <<'EOF'\ncmd //c ver\nEOF");
check('P: heredoc body untouched', heredoc.command.includes('cmd //c ver'), JSON.stringify(heredoc));
const nul = bc('a 2>nul & b &>nul');
check('P: nul forms untouched (deliberate)', nul.command === 'a 2>nul & b &>nul' && !nul.cmdFlagFixed, JSON.stringify(nul));
const singleQ = bc("echo 'cmd //c ver'");
check('P: single-quoted data untouched', singleQ.command === "echo 'cmd //c ver'", JSON.stringify(singleQ));

// --- cmd + non-ASCII detection (data only; no fix attempted) ---
const cn = bc('cmd /c echo 中文');
check('P: cmd+nonASCII flagged', cn.cmdNonAscii === true, JSON.stringify(cn));
const noCn = bc('echo 中文');
check('P: plain nonASCII not flagged', noCn.cmdNonAscii === false, JSON.stringify(noCn));
const cnData = bc('echo cmd 中文');
check('P: cmd-in-data not flagged', cnData.cmdNonAscii === false, JSON.stringify(cnData));

// --- //c with quoted payload: flag fixed, payload kept ---
const quoted = bc('cmd //c "dir > nul"');
check('P: //c fixed, quoted payload kept', quoted.command === 'cmd /c "dir > nul"', JSON.stringify(quoted));

// --- /flag paths must not be confused with //flags ---
const single = bc('cmd /c ver');
check('P: single-slash flag untouched', single.command === 'cmd /c ver' && !single.cmdFlagFixed, JSON.stringify(single));

// --- hook wiring: the two mutation boundaries, exercised through a fake ctx ---
const hooks = {};
const fakeCtx = {
  tool: { hook: (name, cb) => { (hooks['tool:' + name] ??= []).push(cb); return Promise.resolve({ dispose: async () => {} }); } },
  shell: { hook: (name, cb) => { (hooks['shell:' + name] ??= []).push(cb); return Promise.resolve({ dispose: async () => {} }); } },
};
await mod.default.setup(fakeCtx);
const toolBefore = hooks['tool:execute.before']?.[0];
const shellBefore = hooks['shell:create.before']?.[0];
check('H: setup registers both hooks', !!toolBefore && !!shellBefore, Object.keys(hooks).join(','));

const evPath = (tool, p) => ({ tool, input: { path: p } });
const p1 = evPath('write', '/tmp/e2e.txt'); toolBefore(p1);
check('H: tool hook rewrites input.path', p1.input.path === N + 'e2e.txt', JSON.stringify(p1.input));
const p2 = evPath('read', 'C:\\tmp\\x'); toolBefore(p2);
check('H: hook keeps deliberate non-fix', p2.input.path === 'C:\\tmp\\x', JSON.stringify(p2.input));
const p3 = evPath('bash', '/tmp/x'); toolBefore(p3);
check('H: hook ignores non-path tool', p3.input.path === '/tmp/x', JSON.stringify(p3.input));

const bashPath = mod.findBash();
const evShell = (command, shell) => ({ command, cwd: '', timeout: 0, shell, env: {} });
const s1 = evShell('echo cmd //c ver', bashPath); shellBefore(s1);
check('H: shell hook keeps data position', s1.command === 'echo cmd //c ver', JSON.stringify(s1.command));
const s2 = evShell('cmd //c ver', bashPath); shellBefore(s2);
check('H: shell hook rewrites command-position cmd', s2.command === 'cmd /c ver', JSON.stringify(s2.command));
const s3 = evShell('cmd //c ver', process.execPath); shellBefore(s3);
check('H: shell hook ignores a non-bash shell', s3.command === 'cmd //c ver', JSON.stringify(s3.command));
const s4 = evShell('cmd //c ver', 'pwsh'); shellBefore(s4);
check('H: shell hook ignores an unresolvable shell', s4.command === 'cmd //c ver', JSON.stringify(s4.command));

// --- bash detection sanity (this machine must find its own MSYS bash) ---
const bash = mod.findBash();
check('P: findBash finds an MSYS bash on this machine', !!bash, String(bash));

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== oc unit battery: ${pass} passed, ${failures.length} failed ===`);
rmSync(scratch, {recursive: true, force: true});
process.exit(failures.length === 0 ? 0 : 1);
