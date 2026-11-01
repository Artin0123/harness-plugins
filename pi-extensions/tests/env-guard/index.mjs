// Unit battery for pi-extensions/env-guard/index.ts
//
//   node pi-extensions/tests/env-guard/index.mjs
//
// Imports the extension's TypeScript directly (jiti-style, no build step)
// and asserts every documented guard plus every deliberately-not-fixed form,
// so the "刻意不修" decisions stay pinned instead of drifting back.
//
// The source now has one runtime import only the host resolves
// (getAgentDir from @earendil-works/pi-coding-agent). Like the OC battery,
// the import is swapped for a stub and the source is loaded from a
// throwaway copy in the system temp dir (nothing added to the repo).
// EG_AGENT_DIR points the stub at a scratch agent dir so the stats
// persistence is exercised without touching ~/.pi. Worker scenarios reuse
// the scratch via EG_SCRATCH (their scrubbed envs make mkdtempSync
// impossible, so the parent provides the dir).
//
// The cmd //c rewrite is gated on a probe of MSYS_NO_PATHCONV inside a spawned
// bash, so its expected result depends on the machine: this box's bashrc sets
// the variable (conversion off -> rewrite), a stock git-bash does not
// (conversion on -> inert, //c is then the only working spelling). Both
// directions are asserted instead of assuming one, so the battery means the
// same thing anywhere.
//
// Needs Node >= 22.6 (type stripping default from 23.6).
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const selfPath = fileURLToPath(import.meta.url);
const srcPath = join(here, '..', '..', 'env-guard', 'index.ts');
const src = readFileSync(srcPath, 'utf8').replace(
  'import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";',
  'const getAgentDir = () => process.env.EG_AGENT_DIR ?? "";',
);
const scratch = process.env.EG_SCRATCH ?? mkdtempSync(join(tmpdir(), 'env-guard-pi-'));
if (!process.env.EG_SCRATCH) writeFileSync(join(scratch, 'index.ts'), src, 'utf8');
const mod = await import(pathToFileURL(join(scratch, 'index.ts')).href);

// Probe/machine worker modes: cached results mean each scenario needs its own
// process.
if (process.argv.includes('--probe')) {
  console.log(mod.pathConvDisabled() ? 'true' : 'false');
  process.exit(0);
}
if (process.argv.includes('--noanchor')) {
  // Runs with a scrubbed env (see below); prints what the extension would do
  // when it cannot learn bash's /tmp anchor.
  console.log(JSON.stringify({temp: mod.realTempDir(), rewritten: mod.rewritePath('/tmp/x')}));
  process.exit(0);
}
if (process.argv.includes('--shellpath')) {
  // Configured shell (pi's settings.shellPath) decides the probe target.
  const p = process.argv[process.argv.indexOf('--shellpath') + 1] ?? '';
  mod.setConfiguredShell(() => p);
  console.log(JSON.stringify({
    gate: mod.pathConvDisabled(),
    temp: mod.realTempDir(),
    cmd: mod.rewriteBashCommand('cmd //c ver').command,
    path: mod.rewritePath('/tmp/x'),
  }));
  process.exit(0);
}

let pass = 0; const failures = [];
const check = (name, ok, detail) => { if (ok) pass++; else failures.push(`${name} -> ${detail}`); };
const rt = (p) => mod.rewritePath(p);
const bc = (c) => mod.rewriteBashCommand(c);
const T = tmpdir();
const gateOn = mod.pathConvDisabled();

// --- rewritePath: /tmp family ---
check('P: /tmp bare', rt('/tmp') === T, JSON.stringify(rt('/tmp')));
check('P: /tmp/x', rt('/tmp/sub/x.txt') === T + '\\sub\\x.txt', JSON.stringify(rt('/tmp/sub/x.txt')));
check('P: /TMP case-insensitive', rt('/TMP/x') === T + '\\x', JSON.stringify(rt('/TMP/x')));
check('P: /tmp\\foo mixed separator', rt('/tmp\\foo') === T + '\\foo', JSON.stringify(rt('/tmp\\foo')));
check('P: $TEMP/x', rt('$TEMP/x') === T + '\\x', JSON.stringify(rt('$TEMP/x')));
check('P: $temp lowercase', rt('$temp/x') === T + '\\x', JSON.stringify(rt('$temp/x')));
check('P: $TMP/x', rt('$TMP/x') === T + '\\x', JSON.stringify(rt('$TMP/x')));
check('P: $TMPDIR/x', rt('$TMPDIR/x') === T + '\\x', JSON.stringify(rt('$TMPDIR/x')));
check('P: bare $TEMP', rt('$TEMP') === T, JSON.stringify(rt('$TEMP')));
check('P: %TEMP%/x', rt('%TEMP%/x') === T + '\\x', JSON.stringify(rt('%TEMP%/x')));
check('P: %tmp%\\x', rt('%tmp%\\x') === T + '\\x', JSON.stringify(rt('%tmp%\\x')));
check('P: ${TEMP}/x braced', rt('${TEMP}/x') === T + '\\x', JSON.stringify(rt('${TEMP}/x')));
check('P: ${TMPDIR}/x braced', rt('${TMPDIR}/x') === T + '\\x', JSON.stringify(rt('${TMPDIR}/x')));
check('P: bare ${tmp} braced', rt('${tmp}') === T, JSON.stringify(rt('${tmp}')));
check('P: $TEMPFILE/x untouched', rt('$TEMPFILE/x') === '$TEMPFILE/x', JSON.stringify(rt('$TEMPFILE/x')));
check('P: $TMPDIRX/x untouched', rt('$TMPDIRX/x') === '$TMPDIRX/x', JSON.stringify(rt('$TMPDIRX/x')));
check('P: /tmpfoo (prefix, not the dir) untouched', rt('/tmpfoo/x') === '/tmpfoo/x', JSON.stringify(rt('/tmpfoo/x')));

// --- rewritePath: deliberate non-fixes ---
check('P: C:\\tmp untouched (native write ok)', rt('C:\\tmp\\x') === 'C:\\tmp\\x', JSON.stringify(rt('C:\\tmp\\x')));
check('P: relative untouched', rt('relative/x') === 'relative/x', JSON.stringify(rt('relative/x')));
check('P: ~ untouched (tool expands)', rt('~/x') === '~/x', JSON.stringify(rt('~/x')));

// --- rewritePath: MSYS drive letters — deliberately NOT fixed in pi ---
// pi's own resolveToCwd -> normalizeWindowsShellPath already maps /c/Users/x
// -> C:\Users\x (plus /mnt/d, /cygdrive/e), verified e2e (write to /c/tgprobe
// landed at C:\tgprobe, no C:\c). The extension passes them through; a
// rewrite here would be duplicate protection (pure side effect). The same
// rewrite IS justified on hosts without that normalization layer (cmdc).
check('P: /c/Users passes through (pi natively maps)', rt('/c/Users/a') === '/c/Users/a', JSON.stringify(rt('/c/Users/a')));
check('P: /c/tmp passes through', rt('/c/tmp/x') === '/c/tmp/x', JSON.stringify(rt('/c/tmp/x')));

// --- rewritePath: the fault point only exists on Windows ---
// On Linux/macOS /tmp and $TEMP are already correct, so the rewrite must not
// fire at all (measured before the gate: /tmp/x became <home>/AppData/Local/Temp/x).
const realPlatform = process.platform;
let unixPath;
try {
  Object.defineProperty(process, 'platform', {value: 'linux', configurable: true});
  unixPath = rt('/tmp/x');
} finally {
  Object.defineProperty(process, 'platform', {value: realPlatform, configurable: true});
}
check('P: non-win32 leaves /tmp untouched', unixPath === '/tmp/x', JSON.stringify(unixPath));

// --- rewriteBashCommand: doubled flags (probe-gated, both directions pinned) ---
const flagCase = (label, input, expectedWhenOn) => {
  const r = bc(input);
  if (gateOn) check(`P: ${label}`, r.command === expectedWhenOn && r.cmdFlagFixed, JSON.stringify(r));
  else check(`P: ${label} [gate off: untouched]`, r.command === input && !r.cmdFlagFixed, JSON.stringify(r));
};
flagCase('cmd //c -> /c', 'cmd //c ver', 'cmd /c ver');
flagCase('cmd //k -> /k', 'cmd //k dir', 'cmd /k dir');
flagCase('multi-flag //q //c both fixed', 'cmd //q //c ver', 'cmd /q /c ver');
flagCase('tight cmd//c form', 'cmd//c ver', 'cmd /c ver');
flagCase('command position after ;', 'ls; cmd //c ver', 'ls; cmd /c ver');
flagCase('nested $( ) fixed', 'echo "v: $(cmd //c ver)"', 'echo "v: $(cmd /c ver)"');
flagCase('backtick nested fixed', 'echo v: `cmd //c ver`', 'echo v: `cmd /c ver`');
flagCase('//c fixed, quoted payload kept', 'cmd //c "dir > nul"', 'cmd /c "dir > nul"');
flagCase('env-assignment prefix keeps position', 'x=1 cmd //c ver', 'x=1 cmd /c ver');

// --- rewriteBashCommand: POSIX reserved words keep cmd at command position ---
// `if cmd //c ver; then …` is native-correct git-bash syntax (measured: the
// conversion layer turns //c into /c and `ver` runs) and is broken here only
// because this box disables that layer, so the same fault point applies.
// The keyword list is fixed bash grammar — not a guess about which wrappers
// forward a command (see the deliberate-miss list below).
flagCase('after if', 'if cmd //c ver; then echo y; fi', 'if cmd /c ver; then echo y; fi');
flagCase('after {', '{ cmd //c ver; }', '{ cmd /c ver; }');
flagCase('after !', '! cmd //c ver', '! cmd /c ver');
flagCase('after while', 'while cmd //c ver; do break; done', 'while cmd /c ver; do break; done');
flagCase('after do (for-loop body)', 'for i in 1; do cmd //c ver; done', 'for i in 1; do cmd /c ver; done');
flagCase('after time', 'time cmd //c ver', 'time cmd /c ver');

// --- rewriteBashCommand: redirect targets are bash's own path, not argv ---
// Measured: `> //out` fails loudly (`Is a directory`) and `> //tmp/x` fails
// (`No such file or directory`) without creating anything; the double-slash
// idiom only exists to protect arguments that cross the msys argv conversion,
// and a redirect target never does. Rewriting it would silently write
// somewhere else (e.g. `/tmp/eg.log` does get created), so the flag is fixed
// but the target stays exactly as written.
flagCase('redirect target untouched', 'cmd //c "echo hi" > //out', 'cmd /c "echo hi" > //out');
flagCase('redirect target after flag only', 'cmd //c > //out', 'cmd /c > //out');
flagCase('stderr redirect target untouched', 'cmd //c "echo hi" 2> //out', 'cmd /c "echo hi" 2> //out');
flagCase('append redirect target untouched', 'cmd //c "echo hi" >> //out/x', 'cmd /c "echo hi" >> //out/x');
flagCase('input redirect target untouched', 'cmd //c "echo hi" < //in', 'cmd /c "echo hi" < //in');
flagCase('plain redirect target kept', 'cmd //c "echo hi" > out.txt', 'cmd /c "echo hi" > out.txt');

// --- rewriteBashCommand: heredoc terminator follows bash, not trim() ---
// Measured with `bash script.sh`: for `<<'EOF'` the body is sent verbatim, so a
// line that differs only by whitespace is *not* the terminator; `<<-` strips
// leading tabs only. Getting this wrong ends the body early and rewrites lines
// that are still data.
const hdIndented = "cat <<'EOF'\n  EOF\ncmd //c ver\nEOF";
check('P: whitespace-indented EOF is body', bc(hdIndented).command === hdIndented, JSON.stringify(bc(hdIndented).command));
const hdTrailing = "cat <<'EOF'\nEOF  \ncmd //c ver\nEOF";
check('P: trailing-space EOF is body', bc(hdTrailing).command === hdTrailing, JSON.stringify(bc(hdTrailing).command));
const hdDashSpace = 'cat <<-EOF\n  EOF\ncmd //c ver\nEOF';
check('P: <<- does not strip spaces from terminator', bc(hdDashSpace).command === hdDashSpace, JSON.stringify(bc(hdDashSpace).command));
flagCase('<<- tab terminator ends body (bash agrees)', 'cat <<-EOF\n\tEOF\ncmd //c ver\nEOF', 'cat <<-EOF\n\tEOF\ncmd /c ver\nEOF');
// `.` `-` 在 delimiter 裡合法（bash word）；辨識不到＝本體會被當指令改寫
const hdHyphenQ = "cat <<'E-O'\ncmd //c ver\nE-O";
check('P: quoted hyphen delimiter recognised', bc(hdHyphenQ).command === hdHyphenQ, JSON.stringify(bc(hdHyphenQ).command));
const hdHyphen = 'cat <<E-O\ncmd //c ver\nE-O';
check('P: bare hyphen delimiter recognised', bc(hdHyphen).command === hdHyphen, JSON.stringify(bc(hdHyphen).command));
const hdDot = 'cat <<EOF.v2\ncmd //c ver\nEOF.v2';
check('P: dotted delimiter recognised', bc(hdDot).command === hdDot, JSON.stringify(bc(hdDot).command));
const shift = 'echo $((1<<2))';
check('P: arithmetic shift is not a heredoc', bc(shift).command === shift, JSON.stringify(bc(shift)));
// 定界符是 bash 的 word：引號內可含任意內容、也可是跳脫形式（<<\EOF）
const hdEscaped = String.raw`cat <<\EOF` + '\ncmd //c ver\nEOF';
check('P: <<\\EOF delimiter recognised', bc(hdEscaped).command === hdEscaped, JSON.stringify(bc(hdEscaped).command));
const hdSpacesSq = "cat <<'END OF FILE'\ncmd //c ver\nEND OF FILE";
check('P: quoted delimiter with spaces recognised', bc(hdSpacesSq).command === hdSpacesSq, JSON.stringify(bc(hdSpacesSq).command));
const hdSpacesDq = 'cat <<"END OF FILE"\ncmd //c ver\nEND OF FILE';
check('P: double-quoted delimiter recognised', bc(hdSpacesDq).command === hdSpacesDq, JSON.stringify(bc(hdSpacesDq).command));

// --- rewriteBashCommand: token state must not leak out of substitutions ---
// Measured in bash: in `echo `y` cmd …` the substitution IS the command word, so
// `cmd` is only an argument; same for `FOO=bar `y` cmd …` and for `echo hi`y` …`.
// `//x` after a substitution is echo's argument, not a cmd flag.
const tokenLeaks = [
  'echo `cmd` //x',
  'echo $(cmd) //x',
  'echo `y` cmd //c ver',
  'FOO=bar `y` cmd //c ver',
  'echo hi`y` cmd //c ver',
  'echo "$(cmd)" //x',
];
for (const c of tokenLeaks) {
  const r = bc(c);
  check(`P: untouched ${c}`, r.command === c && !r.cmdFlagFixed, JSON.stringify(r));
}
flagCase('separator ends flag context (quoted payload)', 'cmd //c "x" ; //y', 'cmd /c "x" ; //y');
flagCase('separator ends flag context (bare)', 'cmd //c; //x', 'cmd /c; //x');
flagCase('newline ends flag context', 'cmd //c "x"\n//y', 'cmd /c "x"\n//y');
flagCase('substitution as assignment value keeps position', 'x=a`y` cmd //c ver', 'x=a`y` cmd /c ver');

// --- rewriteBashCommand: command-substitution parens restore the outer position ---
// Measured in bash: after a substitution the next word is an argument when the
// substitution itself was the command word (`echo $(ls) cmd …` prints
// `hi cmd //c ver`), and is the real command when the substitution was an
// assignment value (`count=$(echo hi) cmd /c ver` runs cmd). A function
// definition `foo(` followed by `{ … }` keeps the command position too.
flagCase('assignment-prefix substitution keeps position', 'count=$(ls) cmd //c ver', 'count=$(ls) cmd /c ver');
flagCase('arithmetic assignment prefix keeps position', 'x=$((1+1)) cmd //c ver', 'x=$((1+1)) cmd /c ver');
flagCase('substitution value assignment keeps position', 'x=$(echo hi) cmd //c ver', 'x=$(echo hi) cmd /c ver');
flagCase('function definition body', 'foo() { cmd //c ver; }', 'foo() { cmd /c ver; }');
const subLeaks = [
  'echo $(ls) cmd //c ver',
  'echo $(pwd) cmd //c ver',
  'echo $(if true; then 1; fi) cmd //c ver',
  'echo $(for i in 1; do echo $i; done) cmd //c ver',
  'echo $( { x; } ) cmd //c ver',
  '( echo x ) cmd //c ver',
];
for (const c of subLeaks) {
  const r = bc(c);
  check(`P: untouched ${c}`, r.command === c && !r.cmdFlagFixed, JSON.stringify(r));
}
flagCase('CRLF terminator ends body', 'cat <<EOF\nbody\nEOF\r\ncmd //c ver', 'cat <<EOF\nbody\nEOF\r\ncmd /c ver');
flagCase('all-CRLF terminator ends body', 'cat <<EOF\r\nbody\r\nEOF\r\ncmd //c ver', 'cat <<EOF\r\nbody\r\nEOF\r\ncmd /c ver');

// --- case 樣式的 `)` 沒有對應的 `(`（bash 語法上沒這個括號對） ---
// 語法：case（命令位置）備位 → 該 case 的 `in` 開樣式區 → 樣式 `)` 終止樣式
//（不 pop 外層堆疊）並開 body → `;;` 回樣式區 → `esac` 結束；body 內的 `)`
// 一律普通括號。所以 `in` 的 gate 是「看過 case」（它在參數位置），且只有 `;;`
// 會回拋（單一 `;` 是 body 內的指令分隔）。
// 下面兩組：翻正形（bash 實測真的執行 cmd）與資料形（echo 的參數，必須不動）——
// 後者正是 oc 第一版狀態機把資料改壞的形。
const caseFixes = [
  ['case $x in a) cmd //c ver;; esac', 'case $x in a) cmd /c ver;; esac'],
  ['case x in (a) cmd //c ver;; esac', 'case x in (a) cmd /c ver;; esac'],
  ['case x in a|b) cmd //c ver;; esac', 'case x in a|b) cmd /c ver;; esac'],
  ['case x in *) cmd //c ver;; esac', 'case x in *) cmd /c ver;; esac'],
  ['case $a in 1) case $b in x) cmd //c ver;; esac;; esac', 'case $a in 1) case $b in x) cmd /c ver;; esac;; esac'],
  ['case x in a) x=$(pwd) cmd //c ver;; esac', 'case x in a) x=$(pwd) cmd /c ver;; esac'],
  ['case x in a) true;; b) cmd //c ver;; esac', 'case x in a) true;; b) cmd /c ver;; esac'],
  ['case x in a) echo 1;;& b) cmd //c ver;; esac', 'case x in a) echo 1;;& b) cmd /c ver;; esac'],
  ['echo $(case $x in a) cmd //c ver;; esac)', 'echo $(case $x in a) cmd /c ver;; esac)'],
  ['x=$(case 1 in 1) x;; esac) cmd //c ver', 'x=$(case 1 in 1) x;; esac) cmd /c ver'],
  ['case x in a) echo $(case y in b) cmd //c ver;; esac);; esac', 'case x in a) echo $(case y in b) cmd /c ver;; esac);; esac'],
  ['case x in a) y=$(case 1 in 1) z;; esac) cmd //c ver;; esac', 'case x in a) y=$(case 1 in 1) z;; esac) cmd /c ver;; esac'],
];
for (const [input, expected] of caseFixes) flagCase(`case region: ${input}`, input, expected);

const caseData = [
  // oc 第一版狀態機踩到的誤修形：body 裡的 $( ) 是普通括號，cmd 是 echo 的參數
  'case $x in a) echo $(pwd) cmd //c ver;; esac',
  'case $x in a) echo "$(pwd)" cmd //c ver;; esac',
  // case 包在 $( ) 裡時，替換內部的 cmd 是 echo 的資料
  'echo $(case 1 in 1) x;; esac) cmd //c ver',
  'echo $(case 1 in 1) fi;; esac) cmd //c ver',
  'echo $(case 1 in 1) done;; esac) cmd //c ver',
  'echo $(case 1 in (a) x;; esac) cmd //c ver',
  'x=$(case 1 in 1) y;; esac) echo cmd //c ver',
  'case $x in a) echo hi;; esac; echo cmd //c ver',
  // body 內單一 `;` 只是指令分隔，不能把樣式區拉回來
  'case $x in a) echo x; echo cmd //c ver;; esac',
  // body 裡的重導向目標是 bash 自己解析的路徑
  'case x in a) echo hi > //out;; esac',
];
for (const c of caseData) {
  const r = bc(c);
  check(`P: untouched ${c}`, r.command === c && !r.cmdFlagFixed, JSON.stringify(r));
}

// --- rewriteBashCommand: deliberate misses (same in both gate states) ---
// Wrappers would need per-program argument layouts (open-ended guessing);
// absolute/quoted/escaped cmd is native-correct here but never written in
// practice; `cmd //?`, `cmd ///c` also fail on stock git-bash (model error).
const misses = [
  'echo cmd //c ver',
  'echo if cmd //c ver',
  'echo "$(pwd)" cmd //c ver',
  'timeout 5 cmd //c ver',
  'env cmd //c ver',
  '/c/Windows/System32/cmd.exe //c ver',
  '"cmd" //c ver',
  '\\cmd //c ver',
  'cmd //?',
  'cmd ///c ver',
  'printf %s cmd //c',
];
for (const c of misses) {
  const r = bc(c);
  check(`P: untouched ${c}`, r.command === c && !r.cmdFlagFixed, JSON.stringify(r));
}

// A substitution that yields a word, followed by the command: here `cmd` really
// is at command position (`x=`y` cmd …` executes cmd), so this one is fixed.
flagCase('after backtick substitution', 'x=`y` cmd //c ver', 'x=`y` cmd /c ver');

// --- rewriteBashCommand: protected data ---
const heredoc = bc("cat <<'EOF'\ncmd //c ver\nEOF");
check('P: heredoc body untouched', heredoc.command.includes('cmd //c ver'), JSON.stringify(heredoc));
const nul = bc('a 2>nul & b &>nul');
check('P: nul forms untouched (deliberate)', nul.command === 'a 2>nul & b &>nul' && !nul.cmdFlagFixed, JSON.stringify(nul));
const paramExp = bc('echo "${x//c/d}"');
check('P: ${x//c/d} untouched', paramExp.command === 'echo "${x//c/d}"', JSON.stringify(paramExp));

// --- 非 ASCII：不偵測、不改寫，命令原樣通過（兩個 gate 狀態都一樣） ---
const cnPass = bc('cmd /c echo 中文');
check('P: non-ASCII command passed through untouched',
  cnPass.command === 'cmd /c echo 中文' && !cnPass.cmdFlagFixed, JSON.stringify(cnPass));

// --- pathConvDisabled: MSYS disables conversion when the variable is *set* ---
// Measured with a native Windows program's argv: //c arrives as /c when the
// variable is unset (conversion on) and stays //c when it is set to 1, 0, ""
// or false. The probe therefore tests presence, not the value. BASH_ENV is
// removed so the scenarios do not depend on this machine's bashrc.
const envWithout = (...keys) => {
  const env = {...process.env};
  for (const k of keys) {
    for (const name of Object.keys(env)) {
      if (name.toLowerCase() === k.toLowerCase()) delete env[name];
    }
  }
  return env;
};
const probe = (env) => {
  const r = spawnSync(process.execPath, [selfPath, '--probe'], {env: {...env, EG_SCRATCH: scratch}, encoding: 'utf8'});
  return (r.stdout ?? '').trim();
};
check('P: probe false when MSYS_NO_PATHCONV unset', probe(envWithout('BASH_ENV', 'MSYS_NO_PATHCONV')) === 'false', probe(envWithout('BASH_ENV', 'MSYS_NO_PATHCONV')));
check('P: probe true when MSYS_NO_PATHCONV=1', probe({...envWithout('BASH_ENV'), MSYS_NO_PATHCONV: '1'}) === 'true', probe({...envWithout('BASH_ENV'), MSYS_NO_PATHCONV: '1'}));
check('P: probe true when MSYS_NO_PATHCONV=0 (MSYS: presence wins)', probe({...envWithout('BASH_ENV'), MSYS_NO_PATHCONV: '0'}) === 'true', probe({...envWithout('BASH_ENV'), MSYS_NO_PATHCONV: '0'}));
check('P: probe true when MSYS_NO_PATHCONV="" (set but empty)', probe({...envWithout('BASH_ENV'), MSYS_NO_PATHCONV: ''}) === 'true', probe({...envWithout('BASH_ENV'), MSYS_NO_PATHCONV: ''}));

// --- realTempDir: no anchor -> no rewriting (never guess a layout) ---
// Scrubbed env: PATH without any MSYS bash, no Git roots, non-drive TEMP. The
// anchor must then be null (or a real drive path if this machine still resolves
// bash some other way) — never a hardcoded AppData convention.
const noAnchor = JSON.parse(
  spawnSync(process.execPath, [selfPath, '--noanchor'], {
    env: {
      ...envWithout('BASH_ENV', 'MSYS_NO_PATHCONV'),
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
check('P: anchor is null or a drive path (no layout guess)', noAnchor.temp === null || /^[A-Za-z]:[\\/]/.test(noAnchor.temp), JSON.stringify(noAnchor.temp));
check(
  'P: no anchor -> /tmp untouched',
  noAnchor.rewritten === (noAnchor.temp === null ? '/tmp/x' : noAnchor.temp + '\\x'),
  JSON.stringify(noAnchor),
);

// --- configured shell (pi settings.shellPath) is the probe target ---
// Reading the host's own value is exact, not a guess: a configured non-MSYS
// shell (pwsh/cmd/WSL) means neither rewrite applies at all.
const shellRun = (shellPath) => JSON.parse(
  spawnSync(process.execPath, [selfPath, '--shellpath', shellPath], {env: {...process.env, EG_SCRATCH: scratch}, encoding: 'utf8'}).stdout.trim(),
);
const nonMsys = (process.env.SystemRoot ?? 'C:\\Windows') + '\\System32\\cmd.exe';
const cfgNonMsys = shellRun(nonMsys);
check('P: configured non-MSYS shell -> gate off', cfgNonMsys.gate === false, JSON.stringify(cfgNonMsys));
check('P: configured non-MSYS shell -> cmd untouched', cfgNonMsys.cmd === 'cmd //c ver', JSON.stringify(cfgNonMsys));
check(
  'P: configured non-MSYS shell -> /tmp uses the tmpdir fact only',
  cfgNonMsys.path === (cfgNonMsys.temp === null ? '/tmp/x' : cfgNonMsys.temp + '\\x'),
  JSON.stringify(cfgNonMsys),
);
check('P: configured non-MSYS shell -> anchor is null or a drive path', cfgNonMsys.temp === null || /^[A-Za-z]:[\\/]/.test(cfgNonMsys.temp), JSON.stringify(cfgNonMsys.temp));
const msysBash = mod.findBash();
if (msysBash) {
  const cfgMsys = shellRun(msysBash);
  check('P: configured MSYS bash -> gate matches bashrc', cfgMsys.gate === gateOn, JSON.stringify(cfgMsys));
  check('P: configured MSYS bash -> anchor is a drive path', typeof cfgMsys.temp === 'string' && /^[A-Za-z]:[\\/]/.test(cfgMsys.temp), JSON.stringify(cfgMsys));
  check('P: configured MSYS bash -> cmd rewritten like the default path', cfgMsys.cmd === bc('cmd //c ver').command, JSON.stringify(cfgMsys));
} else {
  check('P: configured MSYS bash (skipped: no MSYS bash on this machine)', true, '');
}

// --- non-Windows: the whole extension registers nothing ---
const realPlatformHook = process.platform;
let hookRegistrations = 0;
try {
  Object.defineProperty(process, 'platform', {value: 'linux', configurable: true});
  mod.default({on: () => { hookRegistrations++; }, getSettings: () => ({})});
} finally {
  Object.defineProperty(process, 'platform', {value: realPlatformHook, configurable: true});
}
check('P: non-win32 registers no hook', hookRegistrations === 0, String(hookRegistrations));

// --- usage stats: post-gate denominators, per-fix numerators, JSON file ---
// EG_AGENT_DIR points the getAgentDir stub at a scratch agent dir; a
// pre-existing stats file pins the read-modify-write merge (a restart must
// adopt the old counts and add on top, never overwrite).
const agentDir = join(scratch, 'agent');
mkdirSync(agentDir, {recursive: true});
const statsPath = join(agentDir, 'env-guard-stats.json');
writeFileSync(statsPath, JSON.stringify({schema: 1, since: '2025-01-01T00:00:00.000Z', toolCalls: {read: 7}, fixes: {'path.temp': 3}}), 'utf8');
process.env.EG_AGENT_DIR = agentDir;

const registered = [];
mod.default({ getSettings: () => ({}), on: (ev, fn) => registered.push([ev, fn]) });
const toolCall = registered.find(([e]) => e === 'tool_call')?.[1];
const shutdown = registered.find(([e]) => e === 'session_shutdown')?.[1];
check('S: session_shutdown flush registered', typeof shutdown === 'function', JSON.stringify(registered.map(([e]) => e)));
const uiCtx = { hasUI: false, ui: { notify: () => {} } };
toolCall({ toolName: 'read', input: { path: '/tmp/x' } }, uiCtx);
toolCall({ toolName: 'read', input: { path: 'plain.txt' } }, uiCtx);
toolCall({ toolName: 'find', input: {} }, uiCtx);       // denominator even without a path field
toolCall({ toolName: 'webfetch', input: {} }, uiCtx);   // outside the guard list: not counted
toolCall({ toolName: 'bash', input: { command: 'cmd //c ver' } }, uiCtx);
toolCall({ toolName: 'bash', input: { command: 'cmd /c echo 中文' } }, uiCtx); // 非 ASCII：不偵測不改寫，命令原樣通過
shutdown({}, uiCtx); // flush what the debounce still holds

const saved = JSON.parse(readFileSync(statsPath, 'utf8'));
check('S: denominators merged with prior (read 9, find 1, bash 2)',
  saved.toolCalls.read === 9 && saved.toolCalls.find === 1 && saved.toolCalls.bash === 2,
  JSON.stringify(saved.toolCalls));
check('S: unguarded tool not counted', saved.toolCalls.webfetch === undefined, JSON.stringify(saved.toolCalls));
check('S: path.temp merged on top', saved.fixes['path.temp'] === 4, JSON.stringify(saved.fixes));
check('S: cmd flag counted only when the gate is on', saved.fixes['shell.cmdFlag'] === (gateOn ? 1 : undefined), JSON.stringify(saved.fixes));
check('S: non-ASCII command untouched (no detection, no count)', saved.fixes['shell.cmdNonAscii'] === undefined, JSON.stringify(saved.fixes));
check('S: since preserved across runs', saved.since === '2025-01-01T00:00:00.000Z', JSON.stringify(saved.since));
check('S: no tmp leftovers after flush (per-PID tmp is renamed away)', readdirSync(agentDir).filter((f) => f.endsWith('.tmp')).length === 0, JSON.stringify(readdirSync(agentDir)));

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== pi unit battery: ${pass} passed, ${failures.length} failed (gate ${gateOn ? 'ON: path conversion disabled' : 'OFF: conversion enabled'}) ===`);
process.exit(failures.length === 0 ? 0 : 1);
