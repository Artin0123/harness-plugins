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
import {dirname, join, normalize} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

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
// structured result (per-fix flags for telemetry attribution);
// bc() keeps returning the command so the pinned string comparisons read true
const bcr = (c, convOff = true) => mod.rewriteBashCommand(c, convOff);
const bc = (c) => bcr(c).command;
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
check('P: tight cmd//c form untouched (bash sees a program name; native 127)', tight === 'cmd//c ver', JSON.stringify(tight));
const tightInSeq = bc('FOO=1 cmd//c ver');
check('P: tight form after env prefix untouched', tightInSeq === 'FOO=1 cmd//c ver', JSON.stringify(tightInSeq));
const tightQuoted = bc('"cmd"//c ver');
check('P: quoted tight form untouched', tightQuoted === '"cmd"//c ver', JSON.stringify(tightQuoted));

// --- rewriteBashCommand: position awareness ---
check('P: data position untouched', bc('echo cmd //c ver') === 'echo cmd //c ver', JSON.stringify(bc('echo cmd //c ver')));
// a standalone quoted command word carries the same identity (quote removal is
// part of bash's word parsing; measured native: conv-OFF `"cmd" //c ver` starts
// the interactive cmd -- silent)
check('P: quoted cmd name fixed', bc('"cmd" //c ver') === '"cmd" /c ver', JSON.stringify(bc('"cmd" //c ver')));
check('P: single-quoted cmd name fixed', bc("'cmd' //c ver") === "'cmd' /c ver", JSON.stringify(bc("'cmd' //c ver")));
check('P: quoted full-path cmd.exe fixed', bc('"C:/Windows/System32/cmd.exe" //c ver') === '"C:/Windows/System32/cmd.exe" /c ver', JSON.stringify(bc('"C:/Windows/System32/cmd.exe" //c ver')));
check('P: quoted word in argument position untouched', bc('echo "cmd" //c ver') === 'echo "cmd" //c ver', JSON.stringify(bc('echo "cmd" //c ver')));
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

// --- envp: prefix-assignment POSIX path values (measured fact base: native
// git-bash converts the value grammar at the msys->native boundary,
// name-agnostic; this machine's bashrc disables it, so the rewrite applies.
// Flags first: attribution keys must stay separate (oc-1)) ---
check('E: envp flag attribution separate from cmdFlag',
  bcr('A=/c/x node x').envPathFixed === true && bcr('A=/c/x node x').cmdFlagFixed === false &&
  bcr('cmd //c ver').cmdFlagFixed === true && bcr('cmd //c ver').envPathFixed === false,
  JSON.stringify({ envp: bcr('A=/c/x node x'), flag: bcr('cmd //c ver') }));
const TFS = T.replace(/\\/g, '/');
// the native conversion output is reproduced exactly: /c form, capital drive,
// forward slashes, case-insensitive input; /tmp form via the cygpath anchor
check('E: A=/c/x node applies', bc('A=/c/x node x') === 'A=C:/x node x', JSON.stringify(bc('A=/c/x node x')));
check('E: A=/C/x case-insensitive in', bc('A=/C/x node x') === 'A=C:/x node x', JSON.stringify(bc('A=/C/x node x')));
check('E: bare drive root A=/c -> C:/', bc('A=/c node x') === 'A=C:/ node x', JSON.stringify(bc('A=/c node x')));
check('E: A=/tmp/x -> anchor, forward slashes', bc('A=/tmp/x node x') === 'A=' + TFS + '/x node x', JSON.stringify(bc('A=/tmp/x node x')));
check('E: multiple prefixes all apply', bc('A=/c/x B=/tmp/y node x') === 'A=C:/x B=' + TFS + '/y node x', JSON.stringify(bc('A=/c/x B=/tmp/y node x')));
check('E: keyword continuation (env) still applies', bc('A=/c/x env node x') === 'A=C:/x env node x', JSON.stringify(bc('A=/c/x env node x')));
check('E: exec/command continuation applies', bc('A=/c/x exec node x') === 'A=C:/x exec node x', JSON.stringify(bc('A=/c/x exec node x')));
// empty-value assignment: neither stages (nothing convertible) nor triggers
// apply -- but it does not BLOCK the earlier staged prefix either
check('E: empty value B= applies nothing of itself, keeps earlier', bc('A=/c/x B= node x') === 'A=C:/x B= node x', JSON.stringify(bc('A=/c/x B= node x')));
check('E: standalone assignment is a shell variable (never applies)', bc('A=/c/x') === 'A=/c/x', JSON.stringify(bc('A=/c/x')));
check('E: newline standalone discards', bc('A=/c/x\nnode x') === 'A=/c/x\nnode x', JSON.stringify(bc('A=/c/x\nnode x')));
check('E: ; / | discard the stage', bc('A=/c/x; node x') === 'A=/c/x; node x' && bc('A=/c/x | node x') === 'A=/c/x | node x', JSON.stringify([bc('A=/c/x; node x'), bc('A=/c/x | node x')]));
check('E: background & discards', bc('A=/c/x & node x') === 'A=/c/x & node x', JSON.stringify(bc('A=/c/x & node x')));
check('E: redirect after the assignment discards (interleaved form)', bc('A=/c/x > log node x') === 'A=/c/x > log node x', JSON.stringify(bc('A=/c/x > log node x')));
check('E: fd redirect interleaved is a documented miss', bc('A=/c/x 2>&1 node x') === 'A=/c/x 2>&1 node x', JSON.stringify(bc('A=/c/x 2>&1 node x')));
check('E: bare fd tail persists unconverted', bc('A=/c/x 2>&1') === 'A=/c/x 2>&1', JSON.stringify(bc('A=/c/x 2>&1')));
check('E: heredoc redirect standalone discards', bc('A=/c/x <<EOF\nbody\nEOF\nnode') === 'A=/c/x <<EOF\nbody\nEOF\nnode', JSON.stringify(bc('A=/c/x <<EOF\nbody\nEOF\nnode')));
check('E: word-head # comment discards', bc('A=/c/x # note') === 'A=/c/x # note', JSON.stringify(bc('A=/c/x # note')));
// --- word-head # is a comment: bash ignores the rest of the line, so the
// comment text is dead data that can never reach any program -- copied
// verbatim, never scanned. (Before the fix the comment was tokenized: a "("
// inside was classified as a function definition and reopened command
// position, so `cmd //c ver # note (cmd //x)` rewrote INSIDE the comment --
// a zero-effect misfix.) Word head follows bash's lexer rule: the word
// CONTINUES after a quote or substitution close ("a"#b / $(pwd)#z keep the
// # literal, measured), while a group/subshell/function/arithmetic-command
// ")" and a case-PATTERN ")" open a new word ((true)#c, a)#c are comments,
// measured). ---
check('B: comment content untouched (dead text, not scanned)',
  bc('cmd //c ver # note (cmd //x)') === 'cmd /c ver # note (cmd //x)', JSON.stringify(bc('cmd //c ver # note (cmd //x)')));
check('B: comment with $( ) untouched',
  bc('cmd //c ver # see $(cmd //c ver)') === 'cmd /c ver # see $(cmd //c ver)', JSON.stringify(bc('cmd //c ver # see $(cmd //c ver)')));
check('B: comment ends at newline; next line is a command',
  bc('echo a # note (cmd //x)\ncmd //c ver') === 'echo a # note (cmd //x)\ncmd /c ver', JSON.stringify(bc('echo a # note (cmd //x)\ncmd //c ver')));
check('B: # adjacent to a closed quote is data (word continues)',
  bc('echo "a"# $(cmd //c ver)') === 'echo "a"# $(cmd /c ver)', JSON.stringify(bc('echo "a"# $(cmd //c ver)')));
check('B: # adjacent to a substitution close is data',
  bc('echo $(pwd)# $(cmd //c ver)') === 'echo $(pwd)# $(cmd /c ver)', JSON.stringify(bc('echo $(pwd)# $(cmd //c ver)')));
check('B: # adjacent to a process-substitution close is data',
  bc('echo <(true)# $(cmd //c ver)') === 'echo <(true)# $(cmd /c ver)', JSON.stringify(bc('echo <(true)# $(cmd //c ver)')));
check('B: # adjacent to a case-pattern ) is a comment',
  bc('case x in a)# note (cmd //x)\ncmd //c ver;; esac') === 'case x in a)# note (cmd //x)\ncmd /c ver;; esac', JSON.stringify(bc('case x in a)# note (cmd //x)\ncmd //c ver;; esac')));
check('B: # adjacent to a group ) is a comment',
  bc('(true)# note (cmd //x)') === '(true)# note (cmd //x)', JSON.stringify(bc('(true)# note (cmd //x)')));
check('B: # adjacent to an arithmetic-command ) is a comment',
  bc('((1))# note (cmd //x)') === '((1))# note (cmd //x)', JSON.stringify(bc('((1))# note (cmd //x)')));
check('B: # adjacent to a function-definition ) is a comment',
  bc('f()# note (cmd //x)') === 'f()# note (cmd //x)', JSON.stringify(bc('f()# note (cmd //x)')));
check('B: data-position esac does not end the case section (substitution shape)',
  bc('echo $(case b in a) echo esac;; b) cmd //c ver;; esac)') === 'echo $(case b in a) echo esac;; b) cmd /c ver;; esac)',
  JSON.stringify(bc('echo $(case b in a) echo esac;; b) cmd //c ver;; esac)')));
check('B: esac as the case subject / quoted pattern is not a terminator',
  bc('echo $(case esac in "esac") cmd //c ver;; esac)') === 'echo $(case esac in "esac") cmd /c ver;; esac)',
  JSON.stringify(bc('echo $(case esac in "esac") cmd //c ver;; esac)')));
check('E: builtin command word never applies', bc('A=/c/x echo hi') === 'A=/c/x echo hi', JSON.stringify(bc('A=/c/x echo hi')));
check('E: quoted command word applying via a later word', bc('A=/c/x "node" -e 1') === 'A=C:/x "node" -e 1', JSON.stringify(bc('A=/c/x "node" -e 1')));
// 引號指令字（去引號後參與 token 判定）：bash 的賦值前綴規則在 quote
// removal 之前，所以 "bash"/"echo" 是指令字不是前綴；此前引號隱形，下一個
// 詞被當指令字而誤觸套用（A=/c/x "bash" -c … 實測兩種轉換狀態原生皆 [/c/x]）
check('E: quoted command word alone applies', bc('A=/c/x "node"') === 'A=C:/x "node"', JSON.stringify(bc('A=/c/x "node"')));
check('E: quoted bash command word never applies', bc('A=/c/x "bash" -c "echo $A"') === 'A=/c/x "bash" -c "echo $A"', JSON.stringify(bc('A=/c/x "bash" -c "echo $A"')));
check('E: single-quoted bash command word never applies', bc("A=/c/x 'bash' -c 'echo $A'") === "A=/c/x 'bash' -c 'echo $A'", JSON.stringify(bc("A=/c/x 'bash' -c 'echo $A'")));
check('E: quoted sh command word never applies', bc('A=/c/x "sh" -c x') === 'A=/c/x "sh" -c x', JSON.stringify(bc('A=/c/x "sh" -c x')));
check('E: quoted echo command word never applies', bc('A=/c/x "echo" hi') === 'A=/c/x "echo" hi', JSON.stringify(bc('A=/c/x "echo" hi')));
// 引號偽賦值形是指令字（實測 127）；引號詞在 out 裡帶著引號，走跨度算術會
// 吃掉收尾引號，所以這類詞只當普通指令字
check('E: quoted pseudo-assignment is a command word', bc('A=/c/x "B=/c/y" node x') === 'A=/c/x "B=/c/y" node x', JSON.stringify(bc('A=/c/x "B=/c/y" node x')));
check('E: quoted pseudo-assignment alone', bc('"B=/c/y" node x') === '"B=/c/y" node x', JSON.stringify(bc('"B=/c/y" node x')));
// exec/command/builtin 後的賦值是參數不是前綴：bash 把 X=/c/x 當指令名跑、
// 原生就大聲失敗（實測 127/127/1，兩種轉換狀態同訊息）→ 不暫存
check('E: command-assignment argument is not a prefix', bc('command X=/c/x node x') === 'command X=/c/x node x', JSON.stringify(bc('command X=/c/x node x')));
check('E: exec-assignment argument is not a prefix', bc('exec X=/c/x node x') === 'exec X=/c/x node x', JSON.stringify(bc('exec X=/c/x node x')));
check('E: builtin-assignment argument is not a prefix', bc('builtin X=/c/x node x') === 'builtin X=/c/x node x', JSON.stringify(bc('builtin X=/c/x node x')));
// env is a POSIX external program: its X= argument crosses msys->native
check('E: env assignment forwards to an external', bc('env X=/c/x node x') === 'env X=C:/x node x', JSON.stringify(bc('env X=/c/x node x')));
check('E: env assignment after another prefix both apply', bc('A=/c/x env X=/c/y node x') === 'A=C:/x env X=C:/y node x', JSON.stringify(bc('A=/c/x env X=/c/y node x')));
check('E: tight closed form composes (prefix + verbatim suffix)', bc('VAR=/c/x$(pwd) node x') === 'VAR=C:/x$(pwd) node x', JSON.stringify(bc('VAR=/c/x$(pwd) node x')));
// residual misses (native converts these; the scanner cannot see a full
// unquoted value or program-specific argument semantics -- loud or the value
// side, never a silent syntax break):
check('E: VAR=/c$(echo /x) static prefix, drive-letter end -- miss', bc('VAR=/c$(echo /x) node x') === 'VAR=/c$(echo /x) node x', JSON.stringify(bc('VAR=/c$(echo /x) node x')));
check('E: quote-head value -- miss', bc('VAR="/c/x" node x') === 'VAR="/c/x" node x', JSON.stringify(bc('VAR="/c/x" node x')));
check('E: backslash value -- miss', bc('A=/c\\/x node x') === 'A=/c\\/x node x', JSON.stringify(bc('A=/c\\/x node x')));
check('E: colon-list value -- miss (native has its own rules)', bc('A=/c/a:/c/b node x') === 'A=/c/a:/c/b node x', JSON.stringify(bc('A=/c/a:/c/b node x')));
check('E: root-relative value -- miss (MSYS-root mount dependent)', bc('A=/usr/x node x') === 'A=/usr/x node x', JSON.stringify(bc('A=/usr/x node x')));
check('E: single-letter drive roots convert too (letter-generic anchor, like native)', bc('A=/q/x node x') === 'A=Q:/x node x', JSON.stringify(bc('A=/q/x node x')));
check('E: conversion ON -> apply suppressed (duplicate protection)', bcr('A=/c/x node x', false).command === 'A=/c/x node x', JSON.stringify(bcr('A=/c/x node x', false)));
check('E: conversion ON also suppresses mid-command apply', bcr('A=/c/x foo; node x', false).command === 'A=/c/x foo; node x', JSON.stringify(bcr('A=/c/x foo; node x', false)));
// both rewrites eat the same convOff gate; the exported default is FALSE --
// a direct call without gate evidence is inert (uncertainty never enables
// a rewrite)
check('G: cmdFlag eats the same convOff gate (conversion ON -> no rewrite)',
  (() => { const r = bcr('cmd //c ver', false); return r.command === 'cmd //c ver' && !r.cmdFlagFixed && !r.envPathFixed; })(), JSON.stringify(bcr('cmd //c ver', false)));
check('G: default convOff is false (direct call without gate evidence is inert)',
  mod.rewriteBashCommand('cmd //c ver').command === 'cmd //c ver', JSON.stringify(mod.rewriteBashCommand('cmd //c ver')));

// N2 anti-drift: every `enable -a` builtin, used AS the command word, must
// NOT trigger an apply (the value crosses no exec boundary there)
if (mod.findBash()) {
  const enable = spawnSync(mod.findBash(), ['-c', 'enable -a'], { timeout: 10000, windowsHide: true });
  const listed = (enable.stdout?.toString() ?? '').split(/\r?\n/).map((l) => l.trim().split(' ')[0]);
  const forwarded = new Set(['exec', 'command', 'builtin']); // RESERVED continue: apply waits for the next word
  const specials = ['.', ':', '[', '[[', ']]'];
  for (const b of [...listed.filter((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x)), ...specials]) {
    check(`N2: enable-a builtin "${b}" never applies`, bc(`A=/c/x ${b} hi`) === `A=/c/x ${b} hi`, JSON.stringify(bc(`A=/c/x ${b} hi`)));
  }
}

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

// a missing tool name must fail safe (documented contract): no throw, no
// rewrite -- never a TypeError from the hook itself
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

const bashPath = mod.findBash();
// gate-aware: on a default git-bash (conversion ON) the probe must leave the
// command alone -- the battery then pins the OFF direction instead of
// failing on machine config
const gateOn = bashPath ? mod.pathConvDisabled(bashPath) : false;
const evShell = (command, shell, cwd = '') => ({ command, cwd, timeout: 0, shell, env: {} });
const s1 = evShell('echo cmd //c ver', bashPath); shellBefore(s1);
check('H: shell hook keeps data position', s1.command === 'echo cmd //c ver', JSON.stringify(s1.command));
const s2 = evShell('cmd //c ver', bashPath); shellBefore(s2);
check(gateOn ? 'H: shell hook rewrites command-position cmd (gate ON)' : 'H: shell hook leaves cmd //c verbatim (gate OFF, default git-bash)',
  s2.command === (gateOn ? 'cmd /c ver' : 'cmd //c ver'), JSON.stringify(s2.command));
const s3 = evShell('cmd //c ver', process.execPath); shellBefore(s3);
check('H: shell hook ignores a non-bash shell', s3.command === 'cmd //c ver', JSON.stringify(s3.command));
const s4 = evShell('cmd //c ver', 'pwsh'); shellBefore(s4);
check('H: shell hook ignores an unresolvable shell', s4.command === 'cmd //c ver', JSON.stringify(s4.command));
// word identity + esac section tracking through the real hook + probe
const s9 = evShell('"cmd" //c ver', bashPath); shellBefore(s9);
check(gateOn ? 'H: shell hook rewrites a quoted command word' : 'H: quoted cmd left alone when the gate is OFF',
  s9.command === (gateOn ? '"cmd" /c ver' : '"cmd" //c ver'), JSON.stringify(s9.command));
const s10 = evShell('echo $(case b in a) echo esac;; b) cmd //c ver;; esac)', bashPath); shellBefore(s10);
check(gateOn ? 'H: shell hook keeps the case section across a data-position esac'
  : 'H: case-in-substitution left alone when the gate is OFF',
  s10.command === (gateOn ? 'echo $(case b in a) echo esac;; b) cmd /c ver;; esac)' : 'echo $(case b in a) echo esac;; b) cmd //c ver;; esac)'),
  JSON.stringify(s10.command));
const s11 = evShell(`A=/c/x "bash" -c 'echo [$A]'`, bashPath); shellBefore(s11);
check('H: quoted builtin command word keeps the assignment unconverted',
  s11.command === `A=/c/x "bash" -c 'echo [$A]'`, JSON.stringify(s11.command));

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

// --- temp mechanism classification is the SAME source as the rewrite ------
// (a value rewrite without its mechanism was how counts used to drift)
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

// --- command position: shells keywords, groups, case patterns, path forms ---
const fullPath = bc('C:\\Windows\\System32\\cmd.exe //c ver');
check('P: unquoted backslash Windows path untouched (bash eats the backslashes: native 127)', fullPath === 'C:\\Windows\\System32\\cmd.exe //c ver', JSON.stringify(fullPath));
const fullPathEscaped = bc('C:\\\\Windows\\\\System32\\\\cmd.exe //c ver');
check('P: double-backslash Windows path untouched (host -c fold + lexer leaves C:Windows…)', fullPathEscaped === 'C:\\\\Windows\\\\System32\\\\cmd.exe //c ver', JSON.stringify(fullPathEscaped));
const fullPathPosix = bc('/c/Windows/System32/cmd.exe //c ver');
check('P: POSIX full-path cmd.exe fixed', fullPathPosix === '/c/Windows/System32/cmd.exe /c ver', JSON.stringify(fullPathPosix));
const fullPathMixed = bc('/c/Windows\\System32\\cmd.exe //c ver');
check('P: unquoted mixed-separator path is not a program (untouched)', fullPathMixed === '/c/Windows\\System32\\cmd.exe //c ver', JSON.stringify(fullPathMixed));
const quotedWinPath = bc('"C:\\Windows\\System32\\cmd.exe" //c ver');
check('P: quoted Windows path fixed (quoted backslashes are literal separators)', quotedWinPath === '"C:\\Windows\\System32\\cmd.exe" /c ver', JSON.stringify(quotedWinPath));
const quotedMixedPath = bc('"/c/Windows\\System32\\cmd.exe" //c ver');
check('P: quoted mixed-separator path fixed (MSYS resolves it)', quotedMixedPath === '"/c/Windows\\System32\\cmd.exe" /c ver', JSON.stringify(quotedMixedPath));
const quotedRelPath = bc('"c\\md" //c ver');
check('P: quoted relative backslash word is not cmd (basename md)', quotedRelPath === '"c\\md" //c ver', JSON.stringify(quotedRelPath));
const trailingBackslash = bc('cmd\\\\ //c ver');
check('P: trailing backslash pair is not cmd (it escapes the separator: native 127)', trailingBackslash === 'cmd\\\\ //c ver', JSON.stringify(trailingBackslash));
const escapedName = bc('\\cmd //c ver');
check('P: escaped cmd name fixed (bash runs cmd)', escapedName === '\\cmd /c ver', JSON.stringify(escapedName));
const midEscapedName = bc('c\\md //c ver');
check('P: mid-word escaped cmd name fixed', midEscapedName === 'c\\md /c ver', JSON.stringify(midEscapedName));
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
// A quoted command name ("cmd") is handled by the word-identity feed (pin
// above); what remains a known miss is a quoted payload an inner program
// executes.
// Known misses (open-set ledger, spec.md 漏修臺帳): a quoted payload an inner
// program executes (`bash -c 'cmd //c ver'` -- the scanner treats quoted
// content as data, and which programs take their first argument as a script
// is an open set; measured: conv-ON prints ver's output, conv-OFF starts
// the interactive-cmd silent failure), and `time -p` (bare `time` is a
// covered keyword, `-p` ends the position; same silent failure, organic
// frequency ~0).
check('P: nested single-quoted payload left alone (known miss)',
  bc("bash -c 'cmd //c ver'") === "bash -c 'cmd //c ver'", JSON.stringify(bc("bash -c 'cmd //c ver'")));
check('P: nested double-quoted payload left alone (known miss)',
  bc('bash -c "cmd //c ver"') === 'bash -c "cmd //c ver"', JSON.stringify(bc('bash -c "cmd //c ver"')));
check('P: time -p left alone (known miss)',
  bc('time -p cmd //c ver') === 'time -p cmd //c ver', JSON.stringify(bc('time -p cmd //c ver')));
// 反斜線換行續接：跳脫對被併進 token、`cmd` 的指令字身分失效（實測：轉換開
// ＝bash 詞法先移除續接對、`//c` 經原生轉換成 `/c`、ver 正常；本機轉換關＝
// cmd 收到字面 `//c` 進互動模式 banner、exit 0）→ 漏修臺（pi / oc 同形）
check('P: backslash-newline continuation left alone (known miss)',
  bc('cmd \\\n//c ver') === 'cmd \\\n//c ver', JSON.stringify(bc('cmd \\\n//c ver')));
check('E: backslash-newline after an assignment still composes',
  bc('A=/c/x \\\n node x') === 'A=C:/x \\\n node x', JSON.stringify(bc('A=/c/x \\\n node x')));

// --- escaped \$ ( : literal data, not a substitution opener ---
// bash: "\$(x)" inside double quotes prints $(x) literally (the $ is
// escaped), while "\\$(x)" runs a REAL substitution after a literal
// backslash (measured both). Before the pair-aware scanDq the scanner
// rewrote inside the literal "\$( )" -- silently corrupting echo's data
// (the rewritten run prints $(cmd /c ver), native prints $(cmd //c ver)).
check('B: dq "\\$(" stays literal (data, not substitution)',
  bc('echo "\\$(cmd //c ver)"') === 'echo "\\$(cmd //c ver)"', JSON.stringify(bc('echo "\\$(cmd //c ver)"')));
check('B: dq "\\\\$(" is a real substitution, still fixed',
  bc('echo "\\\\$(cmd //c ver)"') === 'echo "\\\\$(cmd /c ver)"', JSON.stringify(bc('echo "\\\\$(cmd //c ver)"')));
// bare \$( is a native SYNTAX ERROR (loud, exit 2, measured) in both the
// original and the rewritten form, so the interior rewrite changes nothing
// observable -- pinned to keep the shape classified as native-equivalent
check('B: bare \\$( interior rewritten, native-equivalent failure',
  bc('echo \\$(cmd //c ver)') === 'echo \\$(cmd /c ver)', JSON.stringify(bc('echo \\$(cmd //c ver)')));
// bash runs \cmd exactly like cmd, and the basename isCmdTok covers it
// (measured). The header ledger listed this as a miss -- corrected there;
// pinned here so the ledger and the code cannot drift apart again.
check('P: escaped \\cmd fixed via basename isCmdTok',
  bc('\\cmd //c ver') === '\\cmd /c ver', JSON.stringify(bc('\\cmd //c ver')));

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
// bash ignores ONE trailing \r on the terminator line (measured: a clean
// delimiter followed by an "EOF\r" line DOES terminate the body), so the
// command after it is real and gets rewritten
const crlfMix = bc('cat <<EOF\nbody\nEOF\r\ncmd //c ver');
check('B: "EOF\\r" terminator ends body', crlfMix === 'cat <<EOF\nbody\nEOF\r\ncmd /c ver', JSON.stringify(crlfMix));
const crlfFull = bc('cat <<EOF\r\nbody\r\nEOF\r\ncmd //c ver\r\n');
check('B: full-CRLF heredoc ends body', crlfFull === 'cat <<EOF\r\nbody\r\nEOF\r\ncmd /c ver\r\n', JSON.stringify(crlfFull));
const dashOk = bc('cat <<-EOF\n\tx\n\tEOF\ncmd //c ver');
check('B: <<- tab terminator recognized, next line is a command', dashOk === 'cat <<-EOF\n\tx\n\tEOF\ncmd /c ver', JSON.stringify(dashOk));
check('B: <<- space-indented line is body', bc('cat <<-EOF\n  EOF\ncmd //c ver\nEOF') === 'cat <<-EOF\n  EOF\ncmd //c ver\nEOF', JSON.stringify(bc('cat <<-EOF\n  EOF\ncmd //c ver\nEOF')));

// a closed $( ) / `...` / group ends the command position: the next word is
// an ARGUMENT of the outer command, never rewritten
check('B: echo $(pwd) cmd //c ver untouched', bc('echo $(pwd) cmd //c ver') === 'echo $(pwd) cmd //c ver', JSON.stringify(bc('echo $(pwd) cmd //c ver')));
check('B: echo `pwd` cmd //c ver untouched', bc('echo `pwd` cmd //c ver') === 'echo `pwd` cmd //c ver', JSON.stringify(bc('echo `pwd` cmd //c ver')));

// keyword-final substitutions: the LAST token inside $( ) being fi/done/}/esac
// must not leak command position past the close (found on the pi sibling;
// oc's stack restore already handled the plain forms, but a case PATTERN ")"
// inside a substitution used to steal the $( 's stack entry, leaving the real
// closer to hit an empty stack and reopen command position)
check('B: echo $(if...fi) cmd //c ver untouched', bc('echo $(if true; then 1; fi) cmd //c ver') === 'echo $(if true; then 1; fi) cmd //c ver', JSON.stringify(bc('echo $(if true; then 1; fi) cmd //c ver')));
check('B: echo $(for...done) cmd //c ver untouched', bc('echo $(for i in 1; do echo $i; done) cmd //c ver') === 'echo $(for i in 1; do echo $i; done) cmd //c ver', JSON.stringify(bc('echo $(for i in 1; do echo $i; done) cmd //c ver')));
check('B: echo $( { x; } ) cmd //c ver untouched', bc('echo $( { x; } ) cmd //c ver') === 'echo $( { x; } ) cmd //c ver', JSON.stringify(bc('echo $( { x; } ) cmd //c ver')));
const caseSubst = bc('echo $(case 1 in 1) x;; esac) cmd //c ver');
check('B: case-pattern ")" in substitution keeps the stack', caseSubst === 'echo $(case 1 in 1) x;; esac) cmd //c ver', JSON.stringify(caseSubst));

// --- zero-effect rewrites removed (measured with real bash) --------------
// A word after a compound-command terminator (or a group-subshell close)
// without a separator is a bash syntax error; a loop/list slot is data.
// Rewriting `cmd //c` there changed text only (or changed DATA), so the
// scanner stays inert. Live bodies (then/do, after ; &&) still rewrite.
check('B: group close does not open a command position (native syntax error)',
  bc('(true) cmd //c ver') === '(true) cmd //c ver', JSON.stringify(bc('(true) cmd //c ver')));
check('B: brace close does not open a command position (native syntax error)',
  bc('{ true; } cmd //c ver') === '{ true; } cmd //c ver', JSON.stringify(bc('{ true; } cmd //c ver')));
check('B: fi does not open a command position (native syntax error)',
  bc('if true; then true; fi cmd //c ver') === 'if true; then true; fi cmd //c ver', JSON.stringify(bc('if true; then true; fi cmd //c ver')));
check('B: done does not open a command position (native syntax error)',
  bc('while true; do break; done cmd //c ver') === 'while true; do break; done cmd //c ver', JSON.stringify(bc('while true; do break; done cmd //c ver')));
check('B: esac does not open a command position (native syntax error)',
  bc('case x in a) true;; esac cmd //c ver') === 'case x in a) true;; esac cmd //c ver', JSON.stringify(bc('case x in a) true;; esac cmd //c ver')));
check('B: for-list words are data',
  bc('for x in cmd //c ver; do echo "$x"; done') === 'for x in cmd //c ver; do echo "$x"; done', JSON.stringify(bc('for x in cmd //c ver; do echo "$x"; done')));
check('B: for variable named cmd does not arm the flag zone',
  bc('for cmd in cmd //c; do echo "$cmd"; done') === 'for cmd in cmd //c; do echo "$cmd"; done', JSON.stringify(bc('for cmd in cmd //c; do echo "$cmd"; done')));
check('B: empty-case esac does not steal the substitution close',
  bc('echo $(case x in esac) cmd //c ver') === 'echo $(case x in esac) cmd //c ver', JSON.stringify(bc('echo $(case x in esac) cmd //c ver')));
check('B: unquoted esac pattern line is dead text (untouched)',
  bc('case x in esac) cmd //c ver;; esac') === 'case x in esac) cmd //c ver;; esac', JSON.stringify(bc('case x in esac) cmd //c ver;; esac')));
check('B: then body still fixed', bc('if true; then cmd //c ver; fi') === 'if true; then cmd /c ver; fi', JSON.stringify(bc('if true; then cmd //c ver; fi')));
check('B: do body still fixed', bc('while true; do cmd //c ver; break; done') === 'while true; do cmd /c ver; break; done', JSON.stringify(bc('while true; do cmd //c ver; break; done')));
check('B: group close followed by ; still fixed', bc('(true); cmd //c ver') === '(true); cmd /c ver', JSON.stringify(bc('(true); cmd //c ver')));
check('B: group close followed by && still fixed', bc('(true) && cmd //c ver') === '(true) && cmd /c ver', JSON.stringify(bc('(true) && cmd //c ver')));
check('B: fi followed by ; still fixed', bc('if true; then true; fi; cmd //c ver') === 'if true; then true; fi; cmd /c ver', JSON.stringify(bc('if true; then true; fi; cmd //c ver')));
check('B: done followed by ; still fixed', bc('while true; do break; done; cmd //c ver') === 'while true; do break; done; cmd /c ver', JSON.stringify(bc('while true; do break; done; cmd //c ver')));
check('B: esac followed by ; still fixed', bc('case x in a) true;; esac; cmd //c ver') === 'case x in a) true;; esac; cmd /c ver', JSON.stringify(bc('case x in a) true;; esac; cmd //c ver')));
check('B: brace group followed by ; still fixed', bc('{ true; }; cmd //c ver') === '{ true; }; cmd /c ver', JSON.stringify(bc('{ true; }; cmd //c ver')));
// function definitions: the body must be a compound command (f() cmd is a
// syntax error); a compound starter keeps the body writable.
check('B: function body simple command is dead text (native syntax error)',
  bc('f() cmd //c ver') === 'f() cmd //c ver', JSON.stringify(bc('f() cmd //c ver')));
check('B: function body brace is fixed', bc('f() { cmd //c ver; }') === 'f() { cmd /c ver; }', JSON.stringify(bc('f() { cmd //c ver; }')));
check('B: function body subshell is fixed', bc('f() (cmd //c ver)') === 'f() (cmd /c ver)', JSON.stringify(bc('f() (cmd //c ver)')));
check('B: function body on the next line is fixed', bc('f()\n{ cmd //c ver; }') === 'f()\n{ cmd /c ver; }', JSON.stringify(bc('f()\n{ cmd //c ver; }')));
check('B: function body if is fixed', bc('f() if true; then cmd //c ver; fi') === 'f() if true; then cmd /c ver; fi', JSON.stringify(bc('f() if true; then cmd //c ver; fi')));
check('B: function body case is fixed', bc('f() case x in a) cmd //c ver;; esac') === 'f() case x in a) cmd /c ver;; esac', JSON.stringify(bc('f() case x in a) cmd //c ver;; esac')));
// known miss: `function NAME { … }` (the scanner does not track the name
// slot; use the `f() { … }` spelling, which is rewritten)
check('P: function-keyword body left alone (known miss; write f() { … })',
  bc('function f { cmd //c ver; }') === 'function f { cmd //c ver; }', JSON.stringify(bc('function f { cmd //c ver; }')));
// ... while a top-level case pattern still opens command position
check('B: top-level case pattern still fixed', bc('case x in a) cmd //c ver;; esac') === 'case x in a) cmd /c ver;; esac', JSON.stringify(bc('case x in a) cmd //c ver;; esac')));
// a $( ) in the case BODY is an ordinary paren: its ")" must pop, so the
// word after it stays echo's argument. (The caseDepth variant of the
// previous fix rewrote these -- the whole case..esac was treated as the
// pattern region; caught by the pi sibling's review, measured here first.)
check('B: case body $( ) then cmd untouched', bc('case $x in a) echo $(pwd) cmd //c ver;; esac') === 'case $x in a) echo $(pwd) cmd //c ver;; esac', JSON.stringify(bc('case $x in a) echo $(pwd) cmd //c ver;; esac')));
check('B: case body "; " then $( ) then cmd untouched', bc('case $x in a) echo hi; echo $(pwd) cmd //c ver;; esac') === 'case $x in a) echo hi; echo $(pwd) cmd //c ver;; esac', JSON.stringify(bc('case $x in a) echo hi; echo $(pwd) cmd //c ver;; esac')));
check('B: case body $( ) then //x untouched', bc('case $x in a) echo $(pwd) //x;; esac') === 'case $x in a) echo $(pwd) //x;; esac', JSON.stringify(bc('case $x in a) echo $(pwd) //x;; esac')));
// the substitution output IS the body's command word: cmd is its argument
check('B: case body substitution-as-command, cmd is data', bc('case x in a) $(pwd) cmd //c ver;; esac') === 'case x in a) $(pwd) cmd //c ver;; esac', JSON.stringify(bc('case x in a) $(pwd) cmd //c ver;; esac')));
check('B: echo $((1+1)) cmd //c ver untouched', bc('echo $((1+1)) cmd //c ver') === 'echo $((1+1)) cmd //c ver', JSON.stringify(bc('echo $((1+1)) cmd //c ver')));
check('B: quoted $(...) then cmd untouched', bc('echo "result: $(date)" cmd //c ver') === 'echo "result: $(date)" cmd //c ver', JSON.stringify(bc('echo "result: $(date)" cmd //c ver')));

// the position rules must keep every legitimately-command-position form:
check('B: case (a) cmd still fixed', bc('case x in (a) cmd //c ver;; esac') === 'case x in (a) cmd /c ver;; esac', JSON.stringify(bc('case x in (a) cmd //c ver;; esac')));
check('B: function body cmd still fixed', bc('foo() { cmd //c ver; }') === 'foo() { cmd /c ver; }', JSON.stringify(bc('foo() { cmd //c ver; }')));
check('B: process substitution still fixed', bc('tee <(cmd //c ver)') === 'tee <(cmd /c ver)', JSON.stringify(bc('tee <(cmd //c ver)')));
check('B: subshell cmd still fixed', bc('(cmd //c ver)') === '(cmd /c ver)', JSON.stringify(bc('(cmd //c ver)')));
check('B: multiline $( ) still fixed', bc('x=$(\ncmd //c ver\n)') === 'x=$(\ncmd /c ver\n)', JSON.stringify(bc('x=$(\ncmd //c ver\n)')));

// token state from INSIDE a substitution must not leak past its close:
// "//x" here is the OUTER command's argument
check('B: echo $(cmd) //x untouched', bc('echo $(cmd) //x') === 'echo $(cmd) //x', JSON.stringify(bc('echo $(cmd) //x')));
check('B: echo `cmd` //x untouched', bc('echo `cmd` //x') === 'echo `cmd` //x', JSON.stringify(bc('echo `cmd` //x')));
const procSub = bc('tee <(cmd //c ver) //x');
check('B: <(cmd //c) then //x untouched', procSub === 'tee <(cmd /c ver) //x', JSON.stringify(procSub));
// a separator kills the flag zone: garbage after ";" is not a flag position
check('B: cmd //c; //x untouched', bc('cmd //c; //x') === 'cmd /c; //x', JSON.stringify(bc('cmd //c; //x')));

// assignment-prefix forms: bash RUNS cmd there (measured:
// "x=`echo hi` cmd /c ver" prints ver's line), so these are command
// positions and get the rewrite -- the restore-at-close rules bring them
// back without touching the data-position cases above
check('B: count=$(cat f) cmd //c fixed', bc('count=$(cat f) cmd //c ver') === 'count=$(cat f) cmd /c ver', JSON.stringify(bc('count=$(cat f) cmd //c ver')));
check('B: x=`y` cmd //c fixed', bc('x=`y` cmd //c ver') === 'x=`y` cmd /c ver', JSON.stringify(bc('x=`y` cmd //c ver')));
check('B: x=$((1+1)) cmd //c fixed', bc('x=$((1+1)) cmd //c ver') === 'x=$((1+1)) cmd /c ver', JSON.stringify(bc('x=$((1+1)) cmd //c ver')));

// cross-review disputed cases (measured against real bash before pinning):
// when the substitution's OUTPUT is the command word, the following cmd is
// an ARGUMENT -- never rewritten. The paren rule captures the position AFTER
// the opening commit, which is exactly this distinction; a cruder
// "restore the outer position" port WOULD misfix these.
check('B: $(ls) cmd //c ver untouched', bc('$(ls) cmd //c ver') === '$(ls) cmd //c ver', JSON.stringify(bc('$(ls) cmd //c ver')));
check('B: FOO=bar `y` cmd //c ver untouched', bc('FOO=bar `y` cmd //c ver') === 'FOO=bar `y` cmd //c ver', JSON.stringify(bc('FOO=bar `y` cmd //c ver')));
check('B: echo hi`y` cmd //c ver untouched', bc('echo hi`y` cmd //c ver') === 'echo hi`y` cmd //c ver', JSON.stringify(bc('echo hi`y` cmd //c ver')));

// --- heredoc delimiters are bash WORDS, not just [A-Za-z0-9_]: dashes, dots
// and quoted delimiters with spaces must delimit the body correctly
// (measured before the fix: '<<'E-O-F'' / '<<'END OF FILE'' bodies were
// rewritten -- the regex did not recognize the delimiter at all)
const dashDelim = bc('cat <<E-O-F\ncmd //c ver\nE-O-F\ncmd //c ver');
check('B: <<E-O-F body data, post-terminator command fixed', dashDelim === 'cat <<E-O-F\ncmd //c ver\nE-O-F\ncmd /c ver', JSON.stringify(dashDelim));
check('B: <<\'E-O-F\' body untouched', bc("cat <<'E-O-F'\ncmd //c ver\nE-O-F") === "cat <<'E-O-F'\ncmd //c ver\nE-O-F", JSON.stringify(bc("cat <<'E-O-F'\ncmd //c ver\nE-O-F")));
check('B: <<\'END OF FILE\' body untouched', bc("cat <<'END OF FILE'\ncmd //c ver\nEND OF FILE") === "cat <<'END OF FILE'\ncmd //c ver\nEND OF FILE", JSON.stringify(bc("cat <<'END OF FILE'\ncmd //c ver\nEND OF FILE")));
check('B: <<EOF.v2 body untouched', bc('cat <<EOF.v2\ncmd //c ver\nEOF.v2') === 'cat <<EOF.v2\ncmd //c ver\nEOF.v2', JSON.stringify(bc('cat <<EOF.v2\ncmd //c ver\nEOF.v2')));
// a quoted delimiter with a space still terminates on the bare line
const spDelim = bc("cat <<'A B'\ncmd //c ver\nA B\ncmd //c ver");
check('B: quoted space delimiter terminates on the bare line', spDelim === "cat <<'A B'\ncmd //c ver\nA B\ncmd /c ver", JSON.stringify(spDelim));
// arithmetic left shift must not open a heredoc (letter-first gate)
check('B: $((1<<2)); cmd still fixed', bc('x=$((1<<2)); cmd //c ver') === 'x=$((1<<2)); cmd /c ver', JSON.stringify(bc('x=$((1<<2)); cmd //c ver')));
check('B: $((a<<b)); cmd still fixed', bc('x=$((a<<b)); cmd //c ver') === 'x=$((a<<b)); cmd /c ver', JSON.stringify(bc('x=$((a<<b)); cmd //c ver')));
// a same-line separator after the heredoc word is still scanned
const sameLine = bc('cat <<EOF; cmd //c ver\nbody\nEOF');
check('B: <<EOF; same-line cmd still fixed', sameLine === 'cat <<EOF; cmd /c ver\nbody\nEOF', JSON.stringify(sameLine));

// --- bash detection sanity (this machine must find its own MSYS bash) ---
const bash = mod.findBash();
check('P: findBash finds an MSYS bash on this machine', !!bash, String(bash));

// --- temp anchor contract: this machine's bash maps /tmp to the user temp,
// and the anchor is a measured drive path (never a guessed layout). Without
// an anchor (no bash / non-drive tmpdir) rewritePath goes inert instead ---
const anchor = mod.realTempDir();
check('P: temp anchor is a drive path equal to tmpdir()',
  typeof anchor === 'string' && /^[A-Za-z]:[\\/]/.test(anchor) && anchor === normalize(tmpdir()),
  JSON.stringify(anchor));

// --- no measured anchor -> inert (worker process, scrubbed environment:
// PATH without any MSYS bash, fake program roots, a non-drive TEMP) ---
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

// --- non-win32: the fault point is the Windows tool layer, /tmp and $TEMP
// are native semantics elsewhere, so nothing may fire and no hook may
// register (the platform check is at call time, pinned via an override) ---
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

// --- probe expansion semantics: MSYS_NO_PATHCONV is presence-based
// (measured: "0", "" and "yes" all disable conversion, so the probe tests
// set-at-all via ${VAR+x}, never the literal value) ---
if (bash) {
  const probeOut = (mutate) => {
    const env = { ...process.env, BASH_ENV: '' };
    mutate(env);
    const r = spawnSync(bash, ['-c', 'printf %s "${MSYS_NO_PATHCONV+x}"'], {
      env, timeout: 5000, windowsHide: true,
    });
    return r.stdout?.toString() ?? '';
  };
  check('P: probe x-expansion: unset is empty', probeOut((e) => { delete e.MSYS_NO_PATHCONV; }) === '', 'probe unset');
  check('P: probe x-expansion: set-empty is x', probeOut((e) => { e.MSYS_NO_PATHCONV = ''; }) === 'x', 'probe set-empty');
  check('P: probe x-expansion: set-0 is x', probeOut((e) => { e.MSYS_NO_PATHCONV = '0'; }) === 'x', 'probe set-0');
  check('P: probe x-expansion: set-1 is x', probeOut((e) => { e.MSYS_NO_PATHCONV = '1'; }) === 'x', 'probe set-1');
}

// --- full pipe (gate ON only): the rewritten command must actually run in
// real bash -- no interactive banner, the payload reaches stdout ---
if (bash && gateOn) {
  const sent = bc('cmd //c echo GUARD_OK');
  const r = spawnSync(bash, ['-c', sent], { timeout: 15000, windowsHide: true });
  check('E: rewritten command executes (GUARD_OK, exit 0)',
    r.status === 0 && (r.stdout?.toString() ?? '').includes('GUARD_OK'),
    JSON.stringify({ sent, status: r.status, out: (r.stdout?.toString() ?? '').slice(0, 80) }));
  const sentAssign = bc('x=`echo hi` cmd //c echo GUARD_OK2');
  const r2 = spawnSync(bash, ['-c', sentAssign], { timeout: 15000, windowsHide: true });
  check('E: assignment-prefix rewrite executes (GUARD_OK2, exit 0)',
    r2.status === 0 && (r2.stdout?.toString() ?? '').includes('GUARD_OK2'),
    JSON.stringify({ sent: sentAssign, status: r2.status, out: (r2.stdout?.toString() ?? '').slice(0, 80) }));
  // a standalone quoted command word runs through the same path (native
  // conv-OFF would start the interactive cmd: banner, no GUARD_OK3)
  const sentQuoted = bc('"cmd" //c echo GUARD_OK3');
  const r3 = spawnSync(bash, ['-c', sentQuoted], { timeout: 15000, windowsHide: true });
  check('E: quoted cmd rewrite executes (GUARD_OK3, exit 0)',
    r3.status === 0 && (r3.stdout?.toString() ?? '').includes('GUARD_OK3'),
    JSON.stringify({ sent: sentQuoted, status: r3.status, out: (r3.stdout?.toString() ?? '').slice(0, 80) }));
}
// e2e, envp cross-check: the fault exists only while the tool's return
// differs from native, so the rewritten command must produce EXACTLY the
// native conversion's output (converted fresh bash, env -u side) -- and a
// no-op command must keep parity too (no divergence). Runs on any machine
// config: the native side gets MSYS_NO_PATHCONV/BASH_ENV stripped, the
// guarded side runs this machine's bash with whatever .bashrc does.
if (bashPath) {
  const convOn = (cmd) => {
    const env = { ...process.env };
    delete env.MSYS_NO_PATHCONV;
    delete env.BASH_ENV;
    // PWD is environment-dependent (this harness exports a Windows-form
    // value; a real bash exports /c/...): $(pwd) would differ between the
    // native and guarded runs for reasons unrelated to the rewrite.
    delete env.PWD;
    return spawnSync(bashPath, ['-c', cmd], { env, timeout: 20000, windowsHide: true });
  };
  const guarded = (cmd) => {
    const env = { ...process.env };
    delete env.PWD; // same isolation as the native side (see convOn)
    return spawnSync(bashPath, ['-c', bc(cmd)], { env, timeout: 20000, windowsHide: true });
  };
  const envpE2E = [
    ['A=/c/x node -e "console.log(process.env.A)"', 'C:/x'],
    ['VAR=/c/x$(pwd) node -e "console.log(process.env.VAR)"', 'C:/x/'],
    ["A=/c/x bash -c 'echo $A'", '/c/x'],
    ["A=/c/x \"bash\" -c 'echo $A'", '/c/x'],
    ["A=/c/x 'bash' -c 'echo $A'", '/c/x'],
    ['A=/c/x env node -e "console.log(process.env.A)"', 'C:/x'],
    ['env X=/c/x node -e "console.log(process.env.X)"', 'C:/x'],
  ];
  for (const [orig, want] of envpE2E) {
    const nat = convOn(orig);
    const gr = guarded(orig);
    const no = (nat.stdout?.toString() ?? '').trim();
    const go = (gr.stdout?.toString() ?? '').trim();
    check('E2E: envp rewrite parity with native (' + want + ')',
      nat.status === 0 && gr.status === 0 && no === go && no.includes(want),
      JSON.stringify([orig, no, go, nat.status, gr.status]));
  }
}

// --- usage telemetry: denominators post-gate, numerators per fix key ---
// Fresh setup over an in-memory storage: the counters start at zero (the
// H-block events above counted without persistence and are discarded by this
// fresh load). The persisted value must round-trip: reload adopts it
// (read-modify-write), a second run adds on top, malformed saved data is
// coerced/dropped and never fatal, and a broken storage never breaks a call.
const savedSets = [];
const mkStatsCtx = (saved, broken = false) => {
  const h = {};
  const ctx = {
    tool: { hook: (name, cb) => { h['tool:' + name] = cb; return Promise.resolve({ dispose: async () => {} }); } },
    shell: { hook: (name, cb) => { h['shell:' + name] = cb; return Promise.resolve({ dispose: async () => {} }); } },
    storage: {
      get: async () => { if (broken) throw new Error('db down'); return saved; },
      // 5ms delay: a cleanup that does not await its write cannot pass the
      // persistence assertions below without the old sleep-after-cleanup hack
      set: async (k, v) => { await new Promise((r) => setTimeout(r, 5)); if (broken) throw new Error('db down'); savedSets.push(v); },
    },
  };
  return { h, ctx };
};

const A = mkStatsCtx(undefined);
const cleanupA = await mod.default.setup(A.ctx);
const tA = A.h['tool:execute.before'];
const sA = A.h['shell:create.before'];
check('S: setup registers both hooks', !!tA && !!sA, Object.keys(A.h).join(','));

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
await sA({ shell: bash, cwd: '/tmp/sub', command: 'cmd //c ver' }); // cmd flag numerator
await sA({ shell: bash, cwd: '/tmp/sub', command: 'A=/c/x node' }); // envp numerator
await sA({ shell: bash, cwd: '$TEMP/sub', command: 'echo hi' }); // var-mechanism workdir

const snapA = mod.statsSnapshot();
check('S: denominators (read 3, glob 2, patch 2, bash 4)',
  snapA.toolCalls.read === 3 && snapA.toolCalls.glob === 2 && snapA.toolCalls.patch === 2 && snapA.toolCalls.bash === 4,
  JSON.stringify(snapA.toolCalls));
check('S: unguarded tool not counted', snapA.toolCalls.webfetch === undefined, JSON.stringify(snapA.toolCalls));
check('S: non-MSYS shell does not bump bash', snapA.toolCalls.bash === 4, JSON.stringify(snapA.toolCalls));
check('S: path.tempMount numerator', snapA.fixes['path.tempMount'] === 1, JSON.stringify(snapA.fixes));
check('S: path.tempVar numerator', snapA.fixes['path.tempVar'] === 1, JSON.stringify(snapA.fixes));
check('S: glob.tempVar numerator', snapA.fixes['glob.tempVar'] === 1, JSON.stringify(snapA.fixes));
check('S: glob.tempMount numerator', snapA.fixes['glob.tempMount'] === 1, JSON.stringify(snapA.fixes));
check('S: patch.tempVar numerator', snapA.fixes['patch.tempVar'] === 1, JSON.stringify(snapA.fixes));
check('S: patch.tempMount numerator', snapA.fixes['patch.tempMount'] === 1, JSON.stringify(snapA.fixes));
check('S: shell.workdir.tempMount numerator (one per MSYS shell event)',
  snapA.fixes['shell.workdir.tempMount'] === 3, JSON.stringify(snapA.fixes));
check('S: shell.workdir.tempVar numerator',
  snapA.fixes['shell.workdir.tempVar'] === 1, JSON.stringify(snapA.fixes));
check('S: legacy path.temp not bumped', snapA.fixes['path.temp'] === undefined, JSON.stringify(snapA.fixes));
check('S: cmd flag numerator (gate-conditional)', snapA.fixes['shell.cmdFlag'] === (gateOn ? 1 : undefined), JSON.stringify(snapA.fixes));
check('S: envp numerator (gate-conditional, its own key -- not cmdFlag)', snapA.fixes['shell.envPath'] === (gateOn ? 1 : undefined), JSON.stringify(snapA.fixes));

await cleanupA(); // the returned promise must cover the final write (Cleanup = () => Promise<void> | void)
check('S: awaited cleanup flush persists (no sleep after cleanup)', savedSets.length >= 1, JSON.stringify(savedSets.length));
const persisted = savedSets[savedSets.length - 1] ?? null; // null when the cleanup write never landed (old fire-and-forget bug)
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
await cleanupB(); // awaited: the +1 read must be persisted when this resolves
check('S: second run adds on top (read-modify-write)',
  savedSets[savedSets.length - 1]?.toolCalls.read === snapA.toolCalls.read + 1,
  JSON.stringify(savedSets[savedSets.length - 1]));

// a call that rewrites nothing must not bump ANY fix key (the old
// "hint/stats without a rewrite" class): denominator only
const Z = mkStatsCtx(undefined);
const cleanupZ = await mod.default.setup(Z.ctx);
await Z.h['tool:execute.before']({ tool: 'read', input: { path: 'plain.txt' } });
await Z.h['tool:execute.before']({ tool: 'patch', input: { patchText: '*** Add File: src/x.ts\n+a\n' } });
await Z.h['shell:create.before']({ shell: bash, cwd: 'C:\\tmp', command: 'echo hi' });
const snapZ = mod.statsSnapshot();
check('S: no rewrite -> no numerator (only tool calls)',
  snapZ.toolCalls.read === 1 && snapZ.toolCalls.patch === 1 && snapZ.toolCalls.bash === 1 &&
  Object.keys(snapZ.fixes).length === 0,
  JSON.stringify({ toolCalls: snapZ.toolCalls, fixes: snapZ.fixes }));
await cleanupZ();

// legacy key in an existing file: historical totals are never renamed; new
// counts use the split keys
const L = mkStatsCtx({ schema: 1, since: 'SINCE-L', toolCalls: {}, fixes: { 'path.temp': 3 } });
const cleanupL = await mod.default.setup(L.ctx);
await L.h['tool:execute.before']({ tool: 'read', input: { path: '/tmp/legacy' } });
const snapL = mod.statsSnapshot();
check('S: legacy path.temp kept untouched', snapL.fixes['path.temp'] === 3, JSON.stringify(snapL.fixes));
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

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== oc unit battery: ${pass} passed, ${failures.length} failed ===`);
rmSync(scratch, {recursive: true, force: true});
process.exit(failures.length === 0 ? 0 : 1);
