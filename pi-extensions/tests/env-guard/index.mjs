// Unit battery for pi-extensions/env-guard/index.ts
//
//   node pi-extensions/tests/env-guard/index.mjs
//
// Imports the extension's TypeScript directly (jiti-style, no build step)
// and asserts every documented guard plus every deliberately-not-fixed form,
// so the "刻意不修" decisions stay pinned instead of drifting back.
//
// The source has two runtime imports only the host resolves
// (getAgentDir and getShellConfig from @earendil-works/pi-coding-agent).
// Like the OC battery, both are swapped for stubs and the source is loaded
// from a throwaway copy in the system temp dir (nothing added to the repo).
// EG_AGENT_DIR points the getAgentDir stub at a scratch agent dir so the stats
// persistence is exercised without touching ~/.pi. EG_SHELL drives the
// getShellConfig stub (the probe wiring itself — verifyMsysBash, cygpath,
// MSYS_NO_PATHCONV — still runs for real against that shell). Worker
// scenarios reuse the scratch via EG_SCRATCH (their scrubbed envs make
// mkdtempSync impossible, so the parent provides the dir).
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
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, existsSync, rmSync} from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const selfPath = fileURLToPath(import.meta.url);
const srcPath = join(here, '..', '..', 'env-guard', 'index.ts');
const src = readFileSync(srcPath, 'utf8').replace(
  'import { getAgentDir, getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";',
  [
    'const getAgentDir = () => process.env.EG_AGENT_DIR ?? "";',
    'const getShellConfig = (p) => { const s = p ?? process.env.EG_SHELL; if (!s) throw new Error("EG_SHELL unset"); return { shell: s, args: ["-c"] }; };',
  ].join('\n'),
);
const scratch = process.env.EG_SCRATCH ?? mkdtempSync(join(tmpdir(), 'env-guard-pi-'));
if (!process.env.EG_SCRATCH) writeFileSync(join(scratch, 'index.ts'), src, 'utf8');
const mod = await import(pathToFileURL(join(scratch, 'index.ts')).href);

// The extension resolves its probe shell through pi's own getShellConfig
// (stubbed above via EG_SHELL). The battery needs a real MSYS bash for the
// same purpose (gate direction, enable -a, worker scenarios), so it scans
// PATH itself — skipping System32 (the WSL launcher stub) and verifying
// uname, the same identity check the extension runs on getShellConfig's
// answer. An already-set EG_SHELL (worker scenarios) wins: the parent chose
// that shell on purpose.
const findBashForTest = () => {
  for (const d of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    if (/\\System32(\\|$)/i.test(d)) continue;
    const c = join(d, 'bash.exe');
    if (!existsSync(c)) continue;
    try {
      const p = spawnSync(c, ['-c', 'uname -s'], {encoding: 'utf8', timeout: 5000});
      if (/^(MINGW|MSYS)/.test((p.stdout ?? '').trim())) return c;
    } catch { /* next candidate */ }
  }
  return null;
};
const msysBash = findBashForTest();
if (msysBash && !process.env.EG_SHELL) process.env.EG_SHELL = msysBash;

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
if (process.argv.includes('--report')) {
  // Probe wiring report: the shell comes from EG_SHELL (the getShellConfig
  // stub). EG_CFG plays settings.shellPath (setConfiguredShell) and must win
  // over detection — the same priority pi's own getShellConfig(customShellPath)
  // applies when it spawns bash.
  if (process.env.EG_CFG) mod.setConfiguredShell(() => process.env.EG_CFG);
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

// rewritePathFix（值＋族別同源）與薄包裝 rewritePath 必須一致
for (const input of ['/tmp/x', '$TEMP/x', '/c/Users/x', 'plain.txt']) {
  check(`S: rewritePath === rewritePathFix().value for ${JSON.stringify(input)}`,
    mod.rewritePath(input) === mod.rewritePathFix(input).value,
    JSON.stringify({a: mod.rewritePath(input), b: mod.rewritePathFix(input)}));
}

// --- 統計分類：temp 修復的兩個故障點必須分開（不是同名 variant）---
// /tmp 是「host 不套 MSYS 映射」、$TEMP 是「host 不展開變數」——修好一邊
// 不等於修好另一邊，所以各有自己的 key；driver2 以外的值不進這兩類。
const cls = (p) => mod.classifyTempFix(p);
check('S: /tmp classified as mount form', cls('/tmp/x') === 'path.tempMount', String(cls('/tmp/x')));
check('S: /TMP classified as mount form (case-insensitive)', cls('/TMP') === 'path.tempMount', String(cls('/TMP')));
check('S: $TEMP classified as var form', cls('$TEMP/x') === 'path.tempVar', String(cls('$TEMP/x')));
check('S: ${TMPDIR} classified as var form', cls('${TMPDIR}/x') === 'path.tempVar', String(cls('${TMPDIR}/x')));
check('S: %TMP% classified as var form', cls('%TMP%' + String.fromCharCode(92) + 'x') === 'path.tempVar', String(cls('%TMP%' + String.fromCharCode(92) + 'x')));
check('S: non-temp path has no temp key', cls('/c/Users/x') === null && cls('plain.txt') === null, String(cls('/c/Users/x')));
check('S: /tmpfoo is not the mount form', cls('/tmpfoo/x') === null, String(cls('/tmpfoo/x')));

// 改寫與計數必須同源：classification 說「不屬於 temp 族」時 rewritePath 不該動；
// 說屬於某一族時 rewritePath 必須真的改（除非平台／錨點不允許，測試環境是 win32
// 且有錨點）。新增 temp 形態只改一邊就會在這裡炸。
for (const [input, kind] of [
  ['/tmp/x', 'path.tempMount'],
  ['$TEMP/x', 'path.tempVar'],
  ['${TMPDIR}/x', 'path.tempVar'],
  ['%TEMP%' + String.fromCharCode(92) + 'x', 'path.tempVar'],
  ['/c/Users/x', null],
  ['C:' + String.fromCharCode(92) + 'tmp' + String.fromCharCode(92) + 'x', null],
]) {
  const out = rt(input);
  const rewritten = out !== input;
  check(`S: rewrite and count agree for ${JSON.stringify(input)}`, cls(input) === kind && rewritten === (kind !== null), JSON.stringify({kind: cls(input), out}));
}

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
flagCase('command position after ;', 'ls; cmd //c ver', 'ls; cmd /c ver');
flagCase('nested $( ) fixed', 'echo "v: $(cmd //c ver)"', 'echo "v: $(cmd /c ver)"');
flagCase('backtick nested fixed', 'echo v: `cmd //c ver`', 'echo v: `cmd /c ver`');
flagCase('//c fixed, quoted payload kept', 'cmd //c "dir > nul"', 'cmd /c "dir > nul"');
flagCase('env-assignment prefix keeps position', 'x=1 cmd //c ver', 'x=1 cmd /c ver');
// 獨立成詞的引號指令字：去引號後參與 token 判定（引號不改變 word 身分）
flagCase('quoted cmd name', '"cmd" //c ver', '"cmd" /c ver');
flagCase('single-quoted cmd name', "'cmd' //c ver", "'cmd' /c ver");
// 程序替換 <( )：內部是新指令語境（bash 會真執行）——本來就會修，釘住防漂移
flagCase('process substitution', 'cat <(cmd //c ver)', 'cat <(cmd /c ver)');
// cmd 的指令字用 basename 比對：這些拼法在 bash 裡都是同一顆 cmd（實測三形在
// 轉換關閉時都進互動式 banner＝同一個故障），整詞比對會把它們留在漏修臺
// bash 會吃掉未引號詞裡的反斜線，所以比對用的是**去跳脫後的詞**：
// `\cmd`／`c\md` 的實際程式名都是 cmd（實測轉換關閉時都進互動 banner）→ 修；
// `C:\Windows\…\cmd.exe` 去跳脫後是 `C:Windows…cmd.exe`（不存在、原生 127）→ 不改。
flagCase('backslash-escaped cmd name', '\\cmd //c ver', '\\cmd /c ver');
flagCase('backslash inside the name (c\md)', 'c\\md //c ver', 'c\\md /c ver');
flagCase('POSIX absolute path cmd', '/c/Windows/System32/cmd.exe //c ver', '/c/Windows/System32/cmd.exe /c ver');
flagCase('quoted absolute path cmd', '"C:/Windows/System32/cmd.exe" //c ver', '"C:/Windows/System32/cmd.exe" /c ver');
flagCase('cmd.exe spelling', 'cmd.exe //c ver', 'cmd.exe /c ver');
// 程序替換的同一個"詞延續"規則：`<(true)#` 的 # 是字面資料，後面的 $( ) 是
// 真的會執行的替換（實測轉換關閉時 banner 真的出來）——不能當註解杒掉
flagCase('word continues past <( ) close', 'echo <(true)# $(cmd //c ver)', 'echo <(true)# $(cmd /c ver)');
flagCase('arithmetic keeps word continuation', 'echo $((1+1))# $(cmd //c ver)', 'echo $((1+1))# $(cmd /c ver)');

// --- rewriteBashCommand: prefix-assignment POSIX paths (probe-gated) ---
// 原生 git-bash 的 envp 轉換（name-agnostic，只看值語法）會把 VAR=/c/foo
// 轉成 C:/foo、VAR=/tmp/x 轉成掛載錨點（正斜線風格，與 cygpath 的反斜線輸出
// 不同——實測如此）；本機轉換被 MSYS_NO_PATHCONV 關閉時值原樣抵達 → Node
// 把前導 / 當磁碟相對路徑解析成 C:\c\foo（靜默錯位，exit 0）。只修「前綴賦值
// ＋後接指令字」；standalone 賦值（bash 端語意需要 POSIX 值）、引號值、清單值、
// 根相對路徑、wrapper 參數一律不動(見 docs/spec.md 刻意不修清單)。
const Tf = String(mod.realTempDir() ?? T).replace(/\\/g, '/');
const envCase = (label, input, expectedWhenOn) => {
  const r = bc(input);
  if (gateOn) check(`P: ${label}`, r.command === expectedWhenOn && r.envPathFixed, JSON.stringify(r));
  else check(`P: ${label} [gate off: untouched]`, r.command === input && !r.envPathFixed, JSON.stringify(r));
};
const envMiss = (c) => {
  const r = bc(c);
  check(`P: untouched ${JSON.stringify(c)}`, r.command === c && !r.envPathFixed, JSON.stringify(r));
};
envCase('drive letter', 'XDG_CACHE_HOME=/c/foo node -e x', 'XDG_CACHE_HOME=C:/foo node -e x');
envCase('other drive', 'CACHE=/d/data git status', 'CACHE=D:/data git status');
envCase('uppercase input drive', 'V=/C/bar cmd', 'V=C:/bar cmd');
envCase('bare drive', 'X=/c node -e y', 'X=C:/ node -e y');
envCase('chained assignments', 'A=/c/x B=/d/y node x', 'A=C:/x B=D:/y node x');
envCase('/tmp value', 'TMPDIR=/tmp node x', 'TMPDIR=' + Tf + ' node x');
envCase('/tmp/sub value', 'TMPDIR=/tmp/sub node x', 'TMPDIR=' + Tf + '/sub node x');
envCase('after !', '! A=/c/x cmd', '! A=C:/x cmd');
envCase('after if', 'if A=/c/x cmd; then echo y; fi', 'if A=C:/x cmd; then echo y; fi');
envCase('in case body', 'case x in a) A=/c/x cmd;; esac', 'case x in a) A=C:/x cmd;; esac');
envCase('inside $( )', 'echo $(A=/c/x node -e y)', 'echo $(A=C:/x node -e y)');
envCase('inside double-quoted $( )', 'echo "$(A=/c/x node -e y)"', 'echo "$(A=C:/x node -e y)"');
envCase('spaced substitution as command word', 'A=/c/x $(pwd) cmd', 'A=C:/x $(pwd) cmd');
// 緊貼形 VAR=/c/x$(…)：組合律——前綴改寫＋逐字後綴＝對串接後完整值的原生轉換
envCase('tight substitution composes', 'A=/c/x$(pwd) cmd', 'A=C:/x$(pwd) cmd');
envCase('redirect after command word', 'A=/c/x node > log', 'A=C:/x node > log');
// 重導向交錯形＝漏修（原生會轉換，但重導向後掃描器已當參數區；fd 前緣
// 2 不再觸發套用——與 A=/c/x > log node 同類，方向安全）
envMiss('A=/c/x 2>&1 cmd');
envMiss('A=/c/x > log node');
// fd 前緣 standalone 形（實測原生持久化 [/c/x]）：純數字詞不觸發套用
envMiss('A=/c/x 2>&1');
envMiss('A=/c/x 2>/dev/null');
// 空值賦值（B=）統一 predicate：既不暫存也不觸發；尾隨空白的 B= 同樣收尾
envMiss('A=/c/x B= ');
// bash 內建：不 spawn → envp 轉換層不存在（實測 A=/c/x eval 'echo $A'
// 原生 [/c/x]；read/cd/source 同）→ 不套用＝與原生一致
envMiss('A=/c/x eval "echo $A"');
envMiss('A=/c/x read line');
envMiss('A=/c/x [[ -d /c/x ]]');
// 引號指令字：獨立成詞且在指令位置時，去引號内容參與 token 判定（引號不改
// 變 word 身分）——"bash"/"echo" 是內建 → 不觸發（未 token 化前下一個詞會以
// 指令位置誤觸套用＝靜默誤修，實測兩種轉換狀態原生皆 [/c/x]）；"node" 是
// 真指令字 → 觸發（原生會轉換）
envMiss('A=/c/x "bash" -c "echo $A"');
envMiss("A=/c/x 'bash' -c 'echo $A'");
envMiss('A=/c/x "sh" -c "echo $A"');
envMiss('A=/c/x "echo" hi');
// 引號指令字單獨形（EOF 收尾）：去引號後就是指令字 → 觸發（實測原生會轉換
// [/c/x→C:/x]）＝與原生一致
envCase('quoted command word alone', 'A=/c/x "node"', 'A=C:/x "node"');
// env 是 POSIX 外部程式：X= 參數跨 msys→native 邊界（實測 env X=/c/x node
// 原生轉換 C:/x）→ 照「賦值前綴」同樣處理——由後續指令字觸發
envCase('env assignment forwards to external', 'env X=/c/x node x', 'env X=C:/x node x');
envCase('env assignment after another prefix', 'A=/c/x env X=/c/y node x', 'A=C:/x env X=C:/y node x');
// exec/command/builtin 後的賦值形是參數（bash 把 X=/c/x 當指令名跑、原生就
// 大聲失敗——實測 127/127/1 同訊息）→ 不暫存、不觸發
envMiss('command X=/c/x node x');
envMiss('exec X=/c/x node x');
envMiss('builtin X=/c/x node x');
// 引號詞裡的伪賦值形（`"B=/c/y"`）：bash 的賦值前綴判定在 quote removal 之前，
// 引號詞是指令字不是前綴（實測 `A=/c/x "B=/c/y" node` → bash: B=/c/y: No such
// file or directory、127）→ 不暫存、不套用。這幾條同時釘住跨度算術：引號詞
// 在 out 裡帶著前後引號，用 curTok 長度回推跨度會吃掉收尾引號（實測曾輸出
// `A=C:/x "BB=C:/y node x`，引號配對被破壞）
envMiss('A=/c/x "B=/c/y" node x');
envMiss("A=/c/x 'B=/c/y' node x");
envMiss('A=/c/x "B=/tmp/y" node x');
envMiss('"B=/c/y" node x');
envMiss('B=/c/y "C=/c/z" node x');
// env 本身是 MSYS 程式：msys→msys 邊界不轉 envp（實測 A=/c/x env 印
// A=/c/x）→ 不動＝原生行為（非漏修）
envMiss('A=/c/x env');
// bash/sh：msys 程式、msys→msys 邊界不轉 envp（實測 A=/c/x bash -c
// 'echo $A' 原生 [/c/x]；內層 spawn native 時原生在內層邊界補轉）→ 不套用
// ＝direct-read 一致、respawn 漏修（安全方向）
envMiss('A=/c/x bash -c "echo $A"');
envMiss('A=/c/x sh -c "echo $A"');
// `:` 與 compopt：內建（防漂移對照由 enable -a 測試覆蓋）
envMiss('A=/c/x :');
envMiss('A=/c/x compopt');
// 函式名殘餘（混合邊界，見 docs/spec.md「envp 殘餘形」）：無法靜態排除→維持套用，釘實際行為
envCase('function name residual (mixed boundary)', 'A=/c/x f', 'A=C:/x f');
// 緊貼組合單獨形：無後接指令字＝standalone（動態輸出進 shell 變數、不轉換）
envMiss('A=/c/x$(pwd)');
envCase('both fixes together', 'A=/c/x cmd //c ver', 'A=C:/x cmd /c ver');
// 空值賦值 B= 保持指令位置續位（bash 語意：空值也進 envp），cmd 觸發套用
envCase('empty assignment keeps position', 'A=/c/x B= cmd', 'A=C:/x B= cmd');
// 引號指令字帶參數：由後續詞（-e）觸發，結果正確（原生 C:/x）
envCase('quoted command word with args', 'A=/c/x "node" -e x', 'A=C:/x "node" -e x');
// command 內建續位（會轉發外部指令）：由 node 觸發套用
envCase('command builtin forwards to external', 'A=/c/x command node x', 'A=C:/x command node x');
envMiss('A=/c/x');
envMiss('A=/c/x; cat $A');
envMiss('A=/c/x\ncat $A');
envMiss('A="/c/foo" node x');
envMiss('export X=/c/foo; node x');
envMiss('echo A=/c/foo');
envMiss('A=/usr/bin node x');
envMiss('A=/tmpfoo/x node x');
envMiss('A=/c/a:/c/b node x');
envMiss('A=/c/x <<EOF\nEOF\ncmd');
// 註解：`A=/c/x # c` 在 bash 是 standalone 賦值＋註解（值不進 envp、原生不轉換
// ）——詞首 # 要把暫存賦值丟掉，否則註解裡的詞被當指令字觸發誤修
envMiss('A=/c/x # comment');
envMiss('A=/c/x # cmd');
// 註解內容是死文字、到達不了任何程式——整段照原樣複製到行尾（同 heredoc
// 本體）。曾把註解照一般掃描：註解裡的 `(` 被分類成函式定義、重開指令位置，
// 死文字裡的 //x 也被改寫＝零效應誤修（每項修復必須指名故障點，死文字沒有
// ——已修＋釘樁）。詞首判準照 bash lexer：引號／替換收尾後詞延續（實測
// `"a"#b`、`$(pwd)#z` 的 # 是字面），樣式區 `)` 後開新詞（實測 `a)#c` 是註解）。
const commentCase = (input, expectedWhenOn) => {
  const r = bc(input);
  if (gateOn) check(`P: comment dead text ${JSON.stringify(input)}`, r.command === expectedWhenOn, JSON.stringify(r));
  else check(`P: comment dead text ${JSON.stringify(input)} [gate off: untouched]`, r.command === input && !r.cmdFlagFixed, JSON.stringify(r));
};
commentCase('cmd //c ver # note (cmd //x)', 'cmd /c ver # note (cmd //x)');
commentCase('cmd //c ver # see $(cmd //c ver)', 'cmd /c ver # see $(cmd //c ver)');
commentCase('echo a # note (cmd //x)\ncmd //c ver', 'echo a # note (cmd //x)\ncmd /c ver');
commentCase('echo "a"# $(cmd //c ver)', 'echo "a"# $(cmd /c ver)');
commentCase('echo $(pwd)# $(cmd //c ver)', 'echo $(pwd)# $(cmd /c ver)');
commentCase('case x in a)# note (cmd //x)\ncmd //c ver;; esac', 'case x in a)# note (cmd //x)\ncmd /c ver;; esac');
// 群組／子殼的 `)` 結尾也是新詞的開頭（實測 `(true)#c` 的 # 是註解）——註解
// 本文不掃；但替換 `$( )` 結尾的詞延續（上面 `echo $(pwd)#` 那條）
commentCase('(true)# note (cmd //x)', '(true)# note (cmd //x)');
commentCase('(true)# note (cmd //x)\ncmd //c ver', '(true)# note (cmd //x)\ncmd /c ver');
// 對照：替換 `$( )` 結尾詞還沒結束，後面的 `#` 是字面資料——那段 `(cmd //x)`
// 是活的子殼（bash 實測 `#` 是字面、`(` 是運算子），所以照常改寫
commentCase('x=$(pwd)# note (cmd //x)\ncmd //c ver', 'x=$(pwd)# note (cmd /x)\ncmd /c ver');
// && 左側是賦值敘述（shell 變數，不進 envp——實測 process.env.A undefined）
envMiss('A=/c/x && node -e y');
envMiss('A=/c/x&&node -e y');
// env 選項交錯形（-u 之後的詞在參數位置——選項結構＝開放集合）→ 留在漏修臺
envMiss('env -u V XDG=/c/foo node x');
// A=x (…) 實測是 syntax error＝死文字，套用與否都無效果；群組內的詞是內建
// （echo）不再觸發套用——不動同樣安全。釘實際行為防止意外漂移。
envMiss('A=/c/x (echo hi)');

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
// 未加引號的定界符可以含任意非元字元字元（實測 `cat <<EOF/x … EOF/x`、`<<EOF#x`
// 都合法）——字元類窄了就會把本體當指令改寫（誤修）。空引號 `<<""` 也是
// 合法定界符（終止行＝空行，實測）：引號分支的 `+` 會讓本體被掃。
for (const [label, text] of [
  ['slash delimiter', 'cat <<EOF/x\ncmd //c ver\nEOF/x'],
  ['hash delimiter', 'cat <<EOF#x\ncmd //c ver\nEOF#x'],
  ['equals delimiter', 'cat <<EOF=x\ncmd //c ver\nEOF=x'],
  ['star delimiter', 'cat <<E*F\ncmd //c ver\nE*F'],
  ['empty quoted delimiter', 'cat <<""\ncmd //c ver\n\necho after'],
  ['empty single-quoted delimiter', "cat <<''\ncmd //c ver\n\necho after"],
]) {
  check(`P: ${label} recognised (body is data)`, bc(text).command === text, JSON.stringify(bc(text).command));
}
const shift = 'echo $((1<<2))';
check('P: arithmetic shift is not a heredoc', bc(shift).command === shift, JSON.stringify(bc(shift)));
// 定界符是 bash 的 word：引號內可含任意內容、也可是跳脫形式（<<\EOF）
const hdEscaped = String.raw`cat <<\EOF` + '\ncmd //c ver\nEOF';
check('P: <<\\EOF delimiter recognised', bc(hdEscaped).command === hdEscaped, JSON.stringify(bc(hdEscaped).command));
const hdSpacesSq = "cat <<'END OF FILE'\ncmd //c ver\nEND OF FILE";
check('P: quoted delimiter with spaces recognised', bc(hdSpacesSq).command === hdSpacesSq, JSON.stringify(bc(hdSpacesSq).command));
const hdSpacesDq = 'cat <<"END OF FILE"\ncmd //c ver\nEND OF FILE';
check('P: double-quoted delimiter recognised', bc(hdSpacesDq).command === hdSpacesDq, JSON.stringify(bc(hdSpacesDq).command));
// 數字開頭的未引號定界符是合法 bash heredoc（實測 `<<2EOF` / `<<-2ND` /
// `<< 2EOF` / `<<\2X` / 巢狀）——此前第一字限字母，本體被當指令掃描、
// `cmd //c` 被改成 `cmd /c`（live 實測：pi bash 工具拿到的本體真的變了）。
// 現在與 oc 同形（`\d*[A-Za-z_…]`）：本體保真。
for (const [label, text] of [
  ['digit-head delimiter <<2EOF', 'cat <<2EOF\ncmd //c ver\n2EOF'],
  ['digit-head with dash <<-2ND', 'cat <<-2ND\n\tcmd //c ver\n\t2ND'],
  ['space before digit-head << 2EOF', 'cat << 2EOF\ncmd //c ver\n2EOF'],
  ['escaped digit-head <<\\2X', String.raw`cat <<\2X` + '\ncmd //c ver\n2X'],
  ['nested digit-head heredocs', 'cat <<2X\ncat <<2Y\ncmd //c ver\n2Y\n2X'],
]) {
  check(`P: ${label} keeps the body literal`, bc(text).command === text, JSON.stringify(bc(text).command));
}
// 已知邊界（誤修、有機頻率 ~0）——這幾條 pin 的是「現況」不是「正確」：第一字
// 不是數字/字母/底線的定界符實測也合法（`<<*X`、`<<.E`），純數字 `<<3` 同；
// 辨識不到→本體被當指令掃描。放寬第一字會把 `$((x<<$y))` 誤判成 heredoc，
// 兩個方向的猜測都只有副作用，所以留著並釘住，哪天動了會在這裡看到。
check('P: BOUNDARY <<*X body is currently scanned', bc('cat <<*X\ncmd //c ver\n*X').command === 'cat <<*X\ncmd /c ver\n*X', JSON.stringify(bc('cat <<*X\ncmd //c ver\n*X').command));
check('P: BOUNDARY <<3 body is currently scanned', bc('cat <<3\ncmd //c ver\n3').command === 'cat <<3\ncmd /c ver\n3', JSON.stringify(bc('cat <<3\ncmd //c ver\n3').command));
// 反方向的邊界（漏修、安全方向）：`$((1<<N))` 的識別字運算元被當 heredoc 開頭、
// 等不到定界符 → 換行後整段不再改寫（實測：後面的 `cmd //c` 保持原樣、live
// 是靜默 banner）。同形不可分（`<<3` 也是合法 heredoc），記臺帳不補貼。
const shiftIdent = 'echo $((1<<SHIFT))\ncmd //c ver';
check('P: BOUNDARY arithmetic <<NAME leaves the next line unrewritten', bc(shiftIdent).command === shiftIdent, JSON.stringify(bc(shiftIdent).command));

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
  // 資料位置的 esac 不再把區段打掉（echo esac 後的 cmd 仍被修）；樣式字面
  // esac）是 bash 語法錯誤（實測兩種轉換狀態皆 error）——掃描器照語法繼續
  // 追蹤、改寫落在死文字上，輸出仍同為語法錯誤＝回傳≡原生
  ['case $x in a) echo esac; cmd //c ver;; esac', 'case $x in a) echo esac; cmd /c ver;; esac'],
  ['case $x in esac) cmd //c ver;; esac', 'case $x in esac) cmd /c ver;; esac'],
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
// absolute/escaped cmd is native-correct here but never written in
// practice; `cmd //?`, `cmd ///c` also fail on stock git-bash (model error).
const misses = [
  'echo cmd //c ver',
  'echo if cmd //c ver',
  'echo "$(pwd)" cmd //c ver',
  'timeout 5 cmd //c ver',
  'xargs cmd //c ver',
  // 死文字形：bash 會吃掉未引號反斜線／路徑本身就不存在 → 原生 127，改寫沒有
  // 任何執行效果（文字有變、行為完全一樣）→ 不動（零效應改寫不新增）
  'C:\\Windows\\System32\\cmd.exe //c ver',
  '/c/Windows\\System32\\cmd.exe //c ver',
  'cmd //?',
  'cmd ///c ver',
  'printf %s cmd //c',
  // 緊貼形（cmd//c、"cmd"//c）不改：bash 把 cmd//c 當程式名，原生是
  // `bash: cmd//c: No such file or directory`、exit 127（兩種轉換狀態實測一致）
  // ——沒有環境故障點支撐；改寫它在 gate ON 時反而把大聲 127 變成 banner 的
  // 靜默失敗。原生的正確回報留給模型看
  'cmd//c ver',
  'cmd//k',
  '"cmd"//c ver',
  'x=1 cmd//c ver',
  // 未引號詞尾的成對反斜線：bash 縮成一層再讓它跳脫分隔符，程式名是 `cmd\`
  // （實測 rc 127、兩種轉換狀態同）——不是指令字。此前 isCmdTok 去反斜線後
  // 命中而改寫 `//c`＝零效應改寫（文字有變、行為一樣）；現在與 oc 同守門
  'cmd\\\\ //c ver',
  // 反斜線換行續接：跳脫對被併進 token、指令字身分失效（實測：轉換開＝
  // 續接後 //c 轉成 /c 真跑；本機＝banner 靜默 exit 0）→ 漏修臺
  'cmd \\\n//c ver',
  // / 前綴原生工具：與 cmd //c 同一個故障點（實測 taskkill //IM
  // exit 1 報『無效參數』；失敗大聲但大聲≠豁免，回傳≠原生才是判準），
  // 留在漏修臺（見 docs/spec.md）——釘住不升級成誤修
  'taskkill //IM media-downloader.exe //F',
  'taskkill //F //IM x.exe',
  'sc //query wuauserv',
  // 引號 payload 被內層程式整體執行：bash/sh -c、node -e、python -c——哪些
  // 程式把首參數當腳本是開放集合 → 留在漏修臺（實測：轉換開＝payload 真跑
  // 、轉換關＝互動模式靜默 exit 0——同一故障深一層；掃描器把引號內容一律
  // 當資料）
  "bash -c 'cmd //c ver'",
  'bash -c "cmd //c ver"',
  // time -p：裸 time 關鍵字已涵蓋、-p 被當普通詞終結指令位置（實測轉換關
  // 進互動模式）；有機頻率≈0，按紀律先記臺
  'time -p cmd //c ver',
  // --- 以下釘住 spec〈只能靠「寫對」的形〉的 A/B 表：這些形一律不動 ----
  // A：刻意不修（回傳≡原生）
  'cmd //server/share',
  'del x',
  'dir /b',
  'echo hi > C:' + String.fromCharCode(92) + 'tmp' + String.fromCharCode(92) + 'eg.txt',
  'echo hi > nul',
  '( echo x ) cmd //c ver', // 原生語法錯誤（子殼後不能直接接指令）
  // B：無法修復（回傳≠原生但靜態不可判定）
  'python /tmp/x.py',   // 原生 exe 的 POSIX 路徑參數（實測兩態解析到不同位置）
  'git -F /tmp/x',
  'taskkill /IM x.exe /F', // gate ON 的正確寫法（單斜線）：不該被改寫
];
for (const c of misses) {
  const r = bc(c);
  check(`P: untouched ${c}`, r.command === c && !r.cmdFlagFixed && !r.envPathFixed, JSON.stringify(r));
}

// --- 跳脫的 \$ ( ：字面資料、不是替換開頭 ---
// bash 實測：雙引號內 "\$(x)" 印字面 $(x)（$ 被跳脫）；"\\$(x)" 才是字面
// 反斜線＋真替換（印 "\<pwd>"）。成對消費跳脫序之前的掃描器把 "\$( )" 內
// 當替換掃描改寫＝靜默誤修 echo 的資料。dq 形兩種 gate 狀態都不動；
// 裸 \$ ( 原生本來就是語法錯誤（大聲、exit 2），改寫前後同形。
check('P: dq "\\$(" 字面資料不動',
  bc('echo "\\$(cmd //c ver)"').command === 'echo "\\$(cmd //c ver)"', JSON.stringify(bc('echo "\\$(cmd //c ver)"')));
flagCase('dq "\\\\$(" 是真替換，照修', 'echo "\\\\$(cmd //c ver)"', 'echo "\\\\$(cmd /c ver)"');
flagCase('裸 \\$( 內部照掃（原生同為語法錯誤）', 'echo \\$(cmd //c ver)', 'echo \\$(cmd /c ver)');

// --- taskkill 事件原形（CS0016 檔案鎖定那條）：整條對 env-guard 是 no-op ---
// cmd.exe /c 是本機（轉換關閉）的正確單斜線形；taskkill 非 cmd、無前綴賦值
// → 兩種改寫都不觸發。病理（//IM 原樣抵達 → exit 1）留在漏修臺：失敗大聲、
// agent 看到即自癒（實錄：拿掉遮罩後下一步就改 /IM）——大聲不是豁免，
// 回傳≠原生才是漏修的判準；事件裡的靜默是模型
// 自己的 >/dev/null 2>&1，屬模型自身錯誤不介入。
const incident = 'cmd.exe /c "csc-build.cmd /nopause media-downloader.cs" 2>&1 | tail -2 && rm -f media-downloader.ini && ./media-downloader.exe & sleep 4; taskkill //IM media-downloader.exe //F >/dev/null 2>&1; sleep 1; sed -n \'1,14p\' media-downloader.ini';
const incidentR = bc(incident);
check('P: taskkill incident command is a no-op', incidentR.command === incident && !incidentR.cmdFlagFixed && !incidentR.envPathFixed, JSON.stringify(incidentR));

// A substitution that yields a word, followed by the command: here `cmd` really
// is at command position (`x=`y` cmd …` executes cmd), so this one is fixed.
flagCase('after backtick substitution', 'x=`y` cmd //c ver', 'x=`y` cmd /c ver');

// --- rewriteBashCommand: protected data ---
const heredoc = bc("cat <<'EOF'\ncmd //c ver\nEOF");
check('P: heredoc body untouched', heredoc.command.includes('cmd //c ver'), JSON.stringify(heredoc));
const nul = bc('a 2>nul & b &>nul');
check('P: nul forms untouched (deliberate)', nul.command === 'a 2>nul & b &>nul' && !nul.cmdFlagFixed, JSON.stringify(nul));
// 重測（轉換開／關皆驗）：本機 bash 對 `> nul` 家族會建實體 nul 檔（非舊註解的
// 「丟棄裝置」）；不修判準不變——bash 原生行為、模型 cmd-ism 自身錯誤
const nul2 = bc('a > nul 2>/dev/null');
check('P: > nul (builds a real file on this bash) untouched', nul2.command === 'a > nul 2>/dev/null' && !nul2.cmdFlagFixed && !nul2.envPathFixed, JSON.stringify(nul2));
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

// --- probe target = pi's own spawn decision (getShellConfig) ---
// Reading the host's own value is exact, not a guess: a configured non-MSYS
// shell (pwsh/cmd/WSL) means neither rewrite applies at all. The worker
// drives the getShellConfig stub through EG_SHELL; EG_CFG plays
// settings.shellPath (setConfiguredShell) and must win over detection —
// the same priority pi's own getShellConfig(customShellPath) applies.
const shellRun = (shellPath) => JSON.parse(
  spawnSync(process.execPath, [selfPath, '--report'], {env: {...process.env, EG_SCRATCH: scratch, EG_SHELL: shellPath}, encoding: 'utf8'}).stdout.trim(),
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
if (msysBash) {
  const cfgMsys = shellRun(msysBash);
  check('P: configured MSYS bash -> gate matches bashrc', cfgMsys.gate === gateOn, JSON.stringify(cfgMsys));
  check('P: configured MSYS bash -> anchor is a drive path', typeof cfgMsys.temp === 'string' && /^[A-Za-z]:[\\/]/.test(cfgMsys.temp), JSON.stringify(cfgMsys));
  check('P: configured MSYS bash -> cmd rewritten like the default path', cfgMsys.cmd === bc('cmd //c ver').command, JSON.stringify(cfgMsys));
  // settings.shellPath wins over PATH detection (pi spawns the configured shell
  // even when another MSYS bash is detectable)
  const cfgWins = JSON.parse(
    spawnSync(process.execPath, [selfPath, '--report'], {env: {...process.env, EG_SCRATCH: scratch, EG_SHELL: msysBash, EG_CFG: nonMsys}, encoding: 'utf8'}).stdout.trim(),
  );
  check('P: settings shellPath wins over detection (configured non-MSYS)', cfgWins.gate === false, JSON.stringify(cfgWins));
} else {
  check('P: configured MSYS bash (skipped: no MSYS bash on this machine)', true, '');
}

// 宿主能力缺失也要誠實：舊 pi（< 0.48.0）沒有 getShellConfig export → 整體
// inert（不刺探、不改寫），而不是拋錯或默默改個不同的對象。
const noCapSrc = readFileSync(srcPath, 'utf8').replace(
  'import { getAgentDir, getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";',
  'const getAgentDir = () => process.env.EG_AGENT_DIR ?? "";\nconst getShellConfig = undefined;',
);
const noCapScratch = mkdtempSync(join(tmpdir(), 'env-guard-nocap-'));
writeFileSync(join(noCapScratch, 'index.ts'), noCapSrc, 'utf8');
const noCap = await import(pathToFileURL(join(noCapScratch, 'index.ts')).href);
check('P: host without getShellConfig -> gate off', noCap.pathConvDisabled() === false, JSON.stringify(noCap.pathConvDisabled()));
check('P: host without getShellConfig -> cmd untouched', noCap.rewriteBashCommand('cmd //c ver').command === 'cmd //c ver', JSON.stringify(noCap.rewriteBashCommand('cmd //c ver').command));
check('P: host without getShellConfig -> anchor falls back to the tmpdir fact', noCap.realTempDir() === mod.realTempDir() || noCap.realTempDir() === null, JSON.stringify(noCap.realTempDir()));
// 宿主缺 getShellConfig 時完全 inert：不改寫、不拋。UI 提示已移除（那是給人
// 看的、對 agent 沒有作用），所以不再有「第一次呼叫通知一次」的行為——這幾條
// 釘住的是「拿掉提示之後行為不變」。
const noCapHooks = [];
noCap.default({on: (ev, fn) => noCapHooks.push([ev, fn]), getSettings: () => ({})});
const noCapToolCall = noCapHooks.find(([e]) => e === 'tool_call')?.[1];
const noCapInput = {command: 'cmd //c ver'};
noCapToolCall({toolName: 'bash', input: noCapInput}); // 不傳 ctx 也不能拋
check('P: host gap leaves the command untouched', noCapInput.command === 'cmd //c ver', JSON.stringify(noCapInput.command));
check('P: host gap handler does not throw without a ctx', (() => { try { noCapToolCall({toolName: 'bash', input: {command: 'cmd //c ver'}}, {}); return true; } catch { return false; } })());
rmSync(noCapScratch, {recursive: true, force: true});

// --- E2E: parity with the native conversion layer (envp family) ---
// 上面所有 envp 案例只是字串比對（"我們預期 C:/x"）；這裡才是真正的驗証：
// 把指令送進真 bash 跑兩次——原生（MSYS_NO_PATHCONV 未設＝MSYS 自己做 envp 轉換）
// 與改寫後（MSYS_NO_PATHCONV=1＝本機配置）。stdout 與 exit 必須一致，否則
// 就是「我們的改寫規則 ≠ MSYS 的轉換規則」。兩邊都 --norc、不設 BASH_ENV，
// 只留 MSYS_NO_PATHCONV 一個變數在控制（與 bashrc 無關）。
// cmd //c 家族不在此列：互動模式會掛、而且那是旗標不是 envp。
if (msysBash) {
  const baseEnv = {...process.env};
  delete baseEnv.BASH_ENV;
  delete baseEnv.MSYS_NO_PATHCONV;
  const nativeEnv = {...baseEnv}; // 轉換 ON（原生預設）
  const fixedEnv = {...baseEnv, MSYS_NO_PATHCONV: '1'}; // 轉換 OFF（本機配置）
  const runBash = (cmd, env) => spawnSync(msysBash, ['--norc', '-c', cmd], {env, encoding: 'utf8', timeout: 30000});
  const parity = (label, cmd, {statusOnly = false} = {}) => {
    if (!gateOn) { check(`E2E parity: ${label} (skipped: gate off, nothing rewritten)`, true, ''); return; }
    const r = bc(cmd);
    const nat = runBash(cmd, nativeEnv);
    const got = runBash(r.command, fixedEnv);
    const outNat = (nat.stdout ?? '').trim();
    const outGot = (got.stdout ?? '').trim();
    const same = statusOnly ? nat.status === got.status : nat.status === got.status && outNat === outGot;
    check(
      `E2E parity: ${label}`,
      same,
      JSON.stringify({input: cmd, rewritten: r.command, native: [nat.status, outNat], fixed: [got.status, outGot]}),
    );
  };
  parity('prefix assignment', "A=/c/x node -e 'process.stdout.write(String(process.env.A))'");
  parity('env wrapper forwards', "env X=/c/x node -e 'process.stdout.write(String(process.env.X))'");
  parity('quoted command word', "A=/c/x \"node\" -e 'process.stdout.write(String(process.env.A))'");
  parity('/tmp value', "TMPDIR=/tmp node -e 'process.stdout.write(String(process.env.TMPDIR))'");
  parity('/tmp/sub value', "TMPDIR=/tmp/sub node -e 'process.stdout.write(String(process.env.TMPDIR))'");
  parity('chained assignments', "A=/c/x B=/d/y node -e 'process.stdout.write(process.env.A+process.env.B)'");
  // 修前是靜默誤修的那條：原生兩態（轉換開／關）都印 /c/x——改寫不該動手
  parity('quoted bash command word is never rewritten', "A=/c/x \"bash\" -c 'echo [$A]'");
  // 大聲失敗形：兩邊都應是 127（訊息含 bash 自己的路徑，故只比 exit）
  parity('quoted pseudo-assignment still fails loudly', 'A=/c/x "B=/c/y" node -e 1', {statusOnly: true});
  parity('command X= still fails loudly', 'command X=/c/x node -e 1', {statusOnly: true});
} else {
  check('E2E parity (skipped: no MSYS bash on this machine)', true, '');
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
const uiCtx = {}; // 通知已移除：ctx 不再被讀，傳空物件就好
toolCall({ toolName: 'read', input: { path: '/tmp/x' } }, uiCtx);
toolCall({ toolName: 'read', input: { path: '$TEMP/y' } }, uiCtx); // 同一個 temp 修復、不同故障點
toolCall({ toolName: 'read', input: { path: 'plain.txt' } }, uiCtx);
toolCall({ toolName: 'find', input: {} }, uiCtx);       // denominator even without a path field
toolCall({ toolName: 'webfetch', input: {} }, uiCtx);   // outside the guard list: not counted
toolCall({ toolName: 'bash', input: { command: 'cmd //c ver' } }, uiCtx);
toolCall({ toolName: 'bash', input: { command: 'cmd /c echo 中文' } }, uiCtx); // 非 ASCII：不偵測不改寫，命令原樣通過
toolCall({ toolName: 'bash', input: { command: 'XDG_CACHE_HOME=/c/foo node -e x' } }, uiCtx);
shutdown({}, uiCtx); // flush what the debounce still holds

// 防漂移：掃描器的指令字排除集必須涵蓋實際 bash 的全部內建（enable -a
// 列舉）。黑箱斷言——每個內建作為 A=/c/x 後的指令字都不應觸發改寫（含
// RESERVED 轉發的 command/exec，單獨形本來就不套用）。bash 不可用時跳過。
if (msysBash) {
  const en = spawnSync(msysBash, ['--norc', '-c', 'enable -a'], {encoding: 'utf8'});
  if (en.status === 0) {
    const words = en.stdout.split('\n').map((l) => l.replace(/^enable\s+[-a]+\s+/, '').trim()).filter(Boolean);
    for (const w of words) {
      const r = mod.rewriteBashCommand(`A=/c/x ${w}`);
      check(`P: builtin ${JSON.stringify(w)} excluded from trigger`, r.command === `A=/c/x ${w}` && !r.envPathFixed, JSON.stringify(r));
    }
    check('P: enable -a parsed non-trivially', words.length > 50, String(words.length));
  }
}

const saved = JSON.parse(readFileSync(statsPath, 'utf8'));
check('S: denominators merged with prior (read 10, find 1, bash 3)',
  saved.toolCalls.read === 10 && saved.toolCalls.find === 1 && saved.toolCalls.bash === 3,
  JSON.stringify(saved.toolCalls));
check('S: unguarded tool not counted', saved.toolCalls.webfetch === undefined, JSON.stringify(saved.toolCalls));
check('S: temp mount fix counted under its own key (path.tempMount)', saved.fixes['path.tempMount'] === 1, JSON.stringify(saved.fixes));
check('S: temp var fix counted separately (path.tempVar)', saved.fixes['path.tempVar'] === 1, JSON.stringify(saved.fixes));
check('S: legacy path.temp key left untouched (old totals are not renamed)', saved.fixes['path.temp'] === 3, JSON.stringify(saved.fixes));
check('S: cmd flag counted only when the gate is on', saved.fixes['shell.cmdFlag'] === (gateOn ? 1 : undefined), JSON.stringify(saved.fixes));
check('S: env path counted only when the gate is on', saved.fixes['shell.envPath'] === (gateOn ? 1 : undefined), JSON.stringify(saved.fixes));
check('S: non-ASCII command untouched (no detection, no count)', saved.fixes['shell.cmdNonAscii'] === undefined, JSON.stringify(saved.fixes));
check('S: since preserved across runs', saved.since === '2025-01-01T00:00:00.000Z', JSON.stringify(saved.since));
check('S: no tmp leftovers after flush (per-PID tmp is renamed away)', readdirSync(agentDir).filter((f) => f.endsWith('.tmp')).length === 0, JSON.stringify(readdirSync(agentDir)));

// --- 並發 sessions 的寫前合併（write-before-read）---
// 另一個 session 在本 session 載入之後、落盤之前寫入了增量；直寫現値
// （last-writer-wins）會吃掉對方的計數——落盤前重讀、增量疊加後兩邊都要在。
const external = JSON.parse(readFileSync(statsPath, 'utf8'));
external.toolCalls.read += 5; // 「另一個 session」落盤的增量
writeFileSync(statsPath, JSON.stringify(external));
toolCall({ toolName: 'read', input: { path: 'plain.txt' } }, uiCtx); // 本 session 再 +1
shutdown({}, uiCtx);
const merged = JSON.parse(readFileSync(statsPath, 'utf8'));
check('S: concurrent increments merged (read 10+5+1)', merged.toolCalls.read === 16, JSON.stringify(merged.toolCalls));
check('S: concurrent merge keeps other keys (find/bash)', merged.toolCalls.find === 1 && merged.toolCalls.bash === 3, JSON.stringify(merged.toolCalls));
check('S: concurrent merge preserves since', merged.since === '2025-01-01T00:00:00.000Z', JSON.stringify(merged.since));

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== pi unit battery: ${pass} passed, ${failures.length} failed (gate ${gateOn ? 'ON: path conversion disabled' : 'OFF: conversion enabled'}) ===`);
process.exit(failures.length === 0 ? 0 : 1);
