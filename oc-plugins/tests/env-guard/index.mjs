// Unit battery for oc-plugins/env-guard/index.ts
//
//   node oc-plugins/tests/env-guard/index.mjs
//
// Imports the plugin's TypeScript directly (type stripping, no build step)
// and asserts every documented guard, every deliberately-not-fixed form, the
// hook wiring, and the boundary cases that must NOT rewrite.
//
// Expected values use os.tmpdir(); the plugin's anchor is `cygpath -w /tmp`
// from the detected bash. On this machine both resolve to the same Windows
// temp dir, so the two can be compared directly.
//
// Needs Node >= 22.6 (type stripping default from 23.6).
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
// The plugin imports `Plugin` from @opencode/plugin (a runtime dep only the
// host resolves). The unit battery targets the exported pure functions, so
// the import is swapped for a passthrough stub and the source is imported
// from a throwaway copy in the system temp dir (nothing added to the repo).
const srcPath = join(here, '..', '..', 'env-guard', 'index.ts');
const src = readFileSync(srcPath, 'utf8')
  .replace('import { Plugin } from "@opencode/plugin"', 'const Plugin = { define: (p) => p };');
const scratch = mkdtempSync(join(tmpdir(), 'env-guard-oc-'));
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
// e2e: read /c/Users/... hit the real file). A rewrite here would be
// duplicate protection (pure side effect).
check('P: /c/Users passes through (host maps natively)', rt('/c/Users/a') === '/c/Users/a', JSON.stringify(rt('/c/Users/a')));
check('P: /c/tmp passes through', rt('/c/tmp/x') === '/c/tmp/x', JSON.stringify(rt('/c/tmp/x')));
// prefix boundaries: a temp-looking name that is not the temp dir stays put
check('P: $TEMPFILE/x untouched', rt('$TEMPFILE/x') === '$TEMPFILE/x', JSON.stringify(rt('$TEMPFILE/x')));
check('P: $TMPDIRX/x untouched', rt('$TMPDIRX/x') === '$TMPDIRX/x', JSON.stringify(rt('$TMPDIRX/x')));
check('P: /tmpfoo/x untouched', rt('/tmpfoo/x') === '/tmpfoo/x', JSON.stringify(rt('/tmpfoo/x')));
check('P: //server/share untouched', rt('//server/share') === '//server/share', JSON.stringify(rt('//server/share')));
check('P: bare %TEMP%', rt('%TEMP%') === T, JSON.stringify(rt('%TEMP%')));

// --- rewriteBashCommand: doubled flags (probe-gated: fires only when the
// spawned bash actually reports MSYS_NO_PATHCONV=1; on a machine without the
// bashrc setting, or when the probe fails, these MUST NOT rewrite) ---
const noConv = bc('cmd //c ver');
check('P: cmd //c -> /c', noConv === 'cmd /c ver', JSON.stringify(noConv));
check('P: cmd //k -> /k', bc('cmd //k dir') === 'cmd /k dir', JSON.stringify(bc('cmd //k dir')));
const multi = bc('cmd //q //c ver');
check('P: multi-flag //q //c both fixed', multi === 'cmd /q /c ver', JSON.stringify(multi));
const tight = bc('cmd//c ver');
check('P: tight cmd//c form', tight === 'cmd /c ver', JSON.stringify(tight));
const tightInSeq = bc('FOO=1 cmd//c ver');
check('P: tight form after env prefix', tightInSeq === 'FOO=1 cmd /c ver', JSON.stringify(tightInSeq));

// --- rewriteBashCommand: position awareness ---
check('P: data position untouched', bc('echo cmd //c ver') === 'echo cmd //c ver', JSON.stringify(bc('echo cmd //c ver')));
const afterSemi = bc('ls; cmd //c ver');
check('P: command position after ; fixed', afterSemi === 'ls; cmd /c ver', JSON.stringify(afterSemi));
const nested = bc('echo "v: $(cmd //c ver)"');
check('P: nested $( ) fixed', nested === 'echo "v: $(cmd /c ver)"', JSON.stringify(nested));
const backtick = bc('echo v: `cmd //c ver`');
check('P: backtick nested fixed', backtick === 'echo v: `cmd /c ver`', JSON.stringify(backtick));
const dqVar = bc('echo "$V"');
check('P: plain double-quote var untouched', dqVar === 'echo "$V"', JSON.stringify(dqVar));
const redirect = bc('cmd //c ver > out.txt');
check('P: redirect target not command position', redirect === 'cmd /c ver > out.txt', JSON.stringify(redirect));
const twoAh = bc('cmd //c ver 2>&1');
check('P: 2>&1 survives', twoAh === 'cmd /c ver 2>&1', JSON.stringify(twoAh));

// --- rewriteBashCommand: protected data ---
const heredoc = bc("cat <<'EOF'\ncmd //c ver\nEOF");
check('P: heredoc body untouched', heredoc.includes('cmd //c ver'), JSON.stringify(heredoc));
const nul = bc('a 2>nul & b &>nul');
check('P: nul forms untouched (deliberate)', nul === 'a 2>nul & b &>nul', JSON.stringify(nul));
const singleQ = bc("echo 'cmd //c ver'");
check('P: single-quoted data untouched', singleQ === "echo 'cmd //c ver'", JSON.stringify(singleQ));

// --- //c with quoted payload: flag fixed, payload kept ---
const quoted = bc('cmd //c "dir > nul"');
check('P: //c fixed, quoted payload kept', quoted === 'cmd /c "dir > nul"', JSON.stringify(quoted));

// --- /flag paths must not be confused with //flags ---
const single = bc('cmd /c ver');
check('P: single-slash flag untouched', single === 'cmd /c ver', JSON.stringify(single));

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
const p4 = { tool: 'glob', input: { pattern: '/tmp/*.txt' } };
toolBefore(p4);
check('H: glob pattern prefix becomes path', p4.input.pattern === '*.txt' && p4.input.path === T, JSON.stringify(p4.input));
const p5 = { tool: 'glob', input: { pattern: '${TEMP}/*.txt', path: 'src' } };
toolBefore(p5);
check('H: glob with explicit path left alone', p5.input.pattern === '${TEMP}/*.txt' && p5.input.path === 'src', JSON.stringify(p5.input));
const p6 = { tool: 'patch', input: { patchText: '*** Add File: /tmp/z.txt\n+x\n' } };
toolBefore(p6);
check('H: patch text rewritten', p6.input.patchText.includes(N + 'z.txt'), JSON.stringify(p6.input));

const bashPath = mod.findBash();
const evShell = (command, shell, cwd = '') => ({ command, cwd, timeout: 0, shell, env: {} });
const s1 = evShell('echo cmd //c ver', bashPath); shellBefore(s1);
check('H: shell hook keeps data position', s1.command === 'echo cmd //c ver', JSON.stringify(s1.command));
const s2 = evShell('cmd //c ver', bashPath); shellBefore(s2);
check('H: shell hook rewrites command-position cmd', s2.command === 'cmd /c ver', JSON.stringify(s2.command));
const s3 = evShell('cmd //c ver', process.execPath); shellBefore(s3);
check('H: shell hook ignores a non-bash shell', s3.command === 'cmd //c ver', JSON.stringify(s3.command));
const s4 = evShell('cmd //c ver', 'pwsh'); shellBefore(s4);
check('H: shell hook ignores an unresolvable shell', s4.command === 'cmd //c ver', JSON.stringify(s4.command));

const s5 = evShell('pwd', bashPath, '/tmp'); shellBefore(s5);
check('H: shell hook rewrites workdir /tmp', s5.cwd === T, JSON.stringify(s5.cwd));
const s6 = evShell('pwd', bashPath, '$TEMP'); shellBefore(s6);
check('H: shell hook rewrites workdir $TEMP', s6.cwd === T, JSON.stringify(s6.cwd));
const s7 = evShell('pwd', bashPath, 'C:\\tmp'); shellBefore(s7);
check('H: shell hook keeps workdir C:\\tmp', s7.cwd === 'C:\\tmp', JSON.stringify(s7.cwd));
const s8 = evShell('pwd', process.execPath, '/tmp'); shellBefore(s8);
check('H: shell hook keeps workdir for non-bash', s8.cwd === '/tmp', JSON.stringify(s8.cwd));

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

// --- command position: shells keywords, groups, case patterns, path forms ---
const fullPath = bc('C:\\Windows\\System32\\cmd.exe //c ver');
check('P: full-path cmd.exe fixed', fullPath === 'C:\\Windows\\System32\\cmd.exe /c ver', JSON.stringify(fullPath));
const thenKw = bc('if true; then cmd //c ver; fi');
check('P: cmd after then', thenKw === 'if true; then cmd /c ver; fi', JSON.stringify(thenKw));
const doKw = bc('for f in a b; do cmd //c ver; done');
check('P: cmd after do', doKw === 'for f in a b; do cmd /c ver; done', JSON.stringify(doKw));
const braceGrp = bc('{ cmd //c ver; }');
check('P: cmd in brace group', braceGrp === '{ cmd /c ver; }', JSON.stringify(braceGrp));
const casePat = bc('case x in a) cmd //c ver;; esac');
check('P: cmd after case pattern )', casePat === 'case x in a) cmd /c ver;; esac', JSON.stringify(casePat));
const timeKw = bc('time cmd //c ver');
check('P: cmd after time', timeKw === 'time cmd /c ver', JSON.stringify(timeKw));
const bang = bc('! cmd //c ver');
check('P: cmd after !', bang === '! cmd /c ver', JSON.stringify(bang));
const envCmd = bc('env FOO=1 cmd //c ver');
check('P: cmd after env', envCmd === 'env FOO=1 cmd /c ver', JSON.stringify(envCmd));
check('P: quoted word in argument position untouched', bc('echo "if" cmd //c ver') === 'echo "if" cmd //c ver', JSON.stringify(bc('echo "if" cmd //c ver')));
check('P: cmd as xargs argument untouched', bc('ls | xargs cmd //c ver') === 'ls | xargs cmd //c ver', JSON.stringify(bc('ls | xargs cmd //c ver')));
// Known miss, pinned on purpose: a quoted command name ("cmd") is not
// recognised. It is fixable in principle but has zero organic occurrences
// (0/508 real commands in this machine's log), so handling it would only add
// scanner risk. Left as-is: pre-plugin behaviour.
check('P: quoted cmd left alone (known miss)', bc('"cmd" //c ver') === '"cmd" //c ver', JSON.stringify(bc('"cmd" //c ver')));

// --- misfix regressions: these silently rewrote correct syntax before the
// position rules were tightened (each verified against real bash first) ---
// redirect targets are bash-internal path syntax: native "> //x" fails loudly
// ("Is a directory") and the rewrite would have silently written to the MSYS
// root instead -- out of scope, leave the failure alone
check('B: cmd > //out untouched', bc('cmd > //out') === 'cmd > //out', JSON.stringify(bc('cmd > //out')));
check('B: cmd < //in untouched', bc('cmd < //in') === 'cmd < //in', JSON.stringify(bc('cmd < //in')));
check('B: cmd >> //log untouched', bc('cmd >> //log') === 'cmd >> //log', JSON.stringify(bc('cmd >> //log')));
const redirAfterFlag = bc('cmd //c < //in');
check('B: flag fixed, redirect target kept', redirAfterFlag === 'cmd /c < //in', JSON.stringify(redirAfterFlag));

// heredoc: <<\EOF (escaped delimiter) is a literal body in bash; the
// terminator line must match EXACTLY (<<- strips leading tabs only), so
// "EOF " / "  EOF" / "EOF\r" terminator look-alikes are BODY
check('B: <<\\EOF body untouched', bc('cat <<\\EOF\ncmd //c ver\nEOF') === 'cat <<\\EOF\ncmd //c ver\nEOF', JSON.stringify(bc('cat <<\\EOF\ncmd //c ver\nEOF')));
check('B: trailing-space terminator is body', bc('cat <<EOF\nbody\nEOF \ncmd //c ver') === 'cat <<EOF\nbody\nEOF \ncmd //c ver', JSON.stringify(bc('cat <<EOF\nbody\nEOF \ncmd //c ver')));
check('B: leading-space terminator is body', bc('cat <<EOF\na\n  EOF\ncmd //c ver\nEOF') === 'cat <<EOF\na\n  EOF\ncmd //c ver\nEOF', JSON.stringify(bc('cat <<EOF\na\n  EOF\ncmd //c ver\nEOF')));
check('B: CRLF terminator is body', bc('cat <<EOF\nbody\nEOF\r\ncmd //c ver') === 'cat <<EOF\nbody\nEOF\r\ncmd //c ver', JSON.stringify(bc('cat <<EOF\nbody\nEOF\r\ncmd //c ver')));
const dashOk = bc('cat <<-EOF\n\tx\n\tEOF\ncmd //c ver');
check('B: <<- tab terminator recognized, next line is a command', dashOk === 'cat <<-EOF\n\tx\n\tEOF\ncmd /c ver', JSON.stringify(dashOk));
check('B: <<- space-indented line is body', bc('cat <<-EOF\n  EOF\ncmd //c ver\nEOF') === 'cat <<-EOF\n  EOF\ncmd //c ver\nEOF', JSON.stringify(bc('cat <<-EOF\n  EOF\ncmd //c ver\nEOF')));

// a closed $( ) / `...` / group ends the command position: the next word is
// an ARGUMENT of the outer command, never rewritten
check('B: echo $(pwd) cmd //c ver untouched', bc('echo $(pwd) cmd //c ver') === 'echo $(pwd) cmd //c ver', JSON.stringify(bc('echo $(pwd) cmd //c ver')));
check('B: echo `pwd` cmd //c ver untouched', bc('echo `pwd` cmd //c ver') === 'echo `pwd` cmd //c ver', JSON.stringify(bc('echo `pwd` cmd //c ver')));
check('B: echo $((1+1)) cmd //c ver untouched', bc('echo $((1+1)) cmd //c ver') === 'echo $((1+1)) cmd //c ver', JSON.stringify(bc('echo $((1+1)) cmd //c ver')));
check('B: quoted $(...) then cmd untouched', bc('echo "result: $(date)" cmd //c ver') === 'echo "result: $(date)" cmd //c ver', JSON.stringify(bc('echo "result: $(date)" cmd //c ver')));

// the position rules must keep every legitimately-command-position form:
check('B: case (a) cmd still fixed', bc('case x in (a) cmd //c ver;; esac') === 'case x in (a) cmd /c ver;; esac', JSON.stringify(bc('case x in (a) cmd //c ver;; esac')));
check('B: function body cmd still fixed', bc('foo() { cmd //c ver; }') === 'foo() { cmd /c ver; }', JSON.stringify(bc('foo() { cmd //c ver; }')));
check('B: process substitution still fixed', bc('tee <(cmd //c ver)') === 'tee <(cmd /c ver)', JSON.stringify(bc('tee <(cmd //c ver)')));
check('B: subshell cmd still fixed', bc('(cmd //c ver)') === '(cmd /c ver)', JSON.stringify(bc('(cmd //c ver)')));
check('B: multiline $( ) still fixed', bc('x=$(\ncmd //c ver\n)') === 'x=$(\ncmd /c ver\n)', JSON.stringify(bc('x=$(\ncmd //c ver\n)')));

// pinned conservative misses (assignment-prefix after a substitution used to
// be rewritten correctly-by-accident; miss beats a silent misfix)
check('B: count=$(...) cmd //c is a pinned miss', bc('count=$(cat f) cmd //c ver') === 'count=$(cat f) cmd //c ver', JSON.stringify(bc('count=$(cat f) cmd //c ver')));
check('B: x=`y` cmd //c is a pinned miss', bc('x=`y` cmd //c ver') === 'x=`y` cmd //c ver', JSON.stringify(bc('x=`y` cmd //c ver')));

// --- bash detection sanity (this machine must find its own MSYS bash) ---
const bash = mod.findBash();
check('P: findBash finds an MSYS bash on this machine', !!bash, String(bash));

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== oc unit battery: ${pass} passed, ${failures.length} failed ===`);
rmSync(scratch, {recursive: true, force: true});
process.exit(failures.length === 0 ? 0 : 1);
