// env-guard -- protects OpenCode's Windows shell and file tools from this
// machine's measured environment failures. Same judgement framework as the
// pi-extensions and cmdc-mods siblings in Artin0123/harness-plugins; every
// fix is anchored to a failure MEASURED on this machine (Git for Windows
// 2.56.0 / MINGW64, opencode v2.2.5). User view & install: README.md; the
// deliberate-no-fix / missed-fix ledgers with the per-item pathologies and
// measurements: docs/spec.md -- comments here and below keep only what
// reading and safely modifying the code requires.
//
// Priority: NATIVE EXECUTION WINS -- syntax that fails under its own native
// execution stays loud (the tool's return equals what native would return;
// the agent sees the real cause and self-corrects); only failures inflicted
// by this environment's conversion/tooling layer (return != native, loud OR
// silent) are fix targets; uncertainty never enables a rewrite -- an
// undetectable bash or a failed probe leaves the plugin inert (寧可漏修，
// 不可誤修：誤修是靜默破壞正確語法；漏修是環境層未修的故障，大聲只是失敗
// 形態，不是不修的豁免).
//
// Fixes (fault points all on this machine's Windows layers; details in the
// functions' own comments):
//   1. paths the host resolves WITHOUT MSYS mapping -- file-tool `path`, the
//      shell tool's `workdir`, a temp prefix in a `glob` pattern, the
//      directive lines of `patch`: /tmp, $TEMP/$TMP/$TMPDIR (bare and
//      ${...}), %TEMP%/%TMP% rewrite to the anchor the detected bash itself
//      reports for /tmp (cygpath -w /tmp), so the file tools and a command's
//      `> /tmp/x` agree on one directory even with a custom fstab;
//      bash-side /tmp is untouched (rewritePath + realTempDir;
//      splitTempPrefix / rewritePatchText for the glob/patch surfaces).
//   2. `cmd //c|//k` -> /c|/k, gated on a probe of MSYS_NO_PATHCONV (the
//      shell's .bashrc sets it through BASH_ENV, so the doubled spelling
//      reaches cmd literally and starts an INTERACTIVE cmd -- exit 0, and
//      the banner's first line mimics `ver` closely enough to be misread as
//      the answer: a silent failure). With conversion ON `//c` is the
//      spelling that works and rewriting it would BE the side effect; a
//      failed or inconclusive probe leaves everything alone (`/c` works in
//      both configurations) (pathConvDisabled + scanBash).
//   3. command-position prefix-assignment POSIX path values -> the native
//      envp conversion value: measured native git-bash converts the VALUE
//      grammar at the msys->native exec boundary, name-agnostic (/c/foo ->
//      C:/foo, /tmp -> its mount anchor); with that layer off the raw value
//      reaches the child and Node resolves /c/foo as drive-relative
//      C:\c\foo with exit 0 (measured silent). Two verifiable anchors only
//      (drive-letter-generic /c, /tmp), deliberately conservative
//      (convertEnvPath + scanBash).
//
// Not fixed (inventory against regression; per-item evidence in spec.md):
//   NATIVE (return == native): C:\tmp in file tools (a legal Windows path,
//     the native write simply succeeds); MSYS drive-letter paths (the
//     host's tool layer maps them itself -- a rewrite would be duplicate
//     protection); `nul` redirect targets (bash-native behaviour);
//     natively-broken `cmd //?`, `///c`, `//server/share` (the model's own
//     syntax error); the tight spelling `cmd//c` / `"cmd"//c` (bash takes it
//     as a PROGRAM NAME: natively `No such file or directory`/127 in both
//     conversion states, loud and self-correcting -- inserting a space only
//     rewrites the model's typo; the environment layer is not broken).
//   MISSED (return != native, but every static rewrite is an open-set
//     guess): //flags of other /-switch programs (taskkill/sc/net/reg/
//     robocopy/findstr -- robocopy does not fail loudly: it treats //xxx as
//     a source path, Windows normalizes it to a UNC path and its default
//     retry loop hangs forever, while natively //xxx converts and fails
//     fast -- the outcomes diverge either way, loudness is not the
//     criterion, the return != native is); cmd behind external wrappers;
//     cmd inside a quoted payload an inner program executes (`bash -c
//     'cmd //c ver'` -- quoted content is data to the scanner, and which
//     programs take their first argument as a script is an open set; measured: conv-ON prints ver's output,
//     conv-OFF starts the interactive-cmd silent failure); `time -p cmd
//     //c ver` (bare `time` is a covered keyword, but `-p` ends the
//     position -- measured, same silent failure; organic frequency ~0);
//     `function NAME { … }` bodies (the name slot is not tracked; `f() { … }`
//     is tracked and works); ANSI-C command words (`$'cmd' //c` -- the scanner
//     copies $'...' as data and does not decode it into a command name);
//     `coproc cmd //c` (not a covered command-position keyword); a redirect
//     written BEFORE the command word (`> log cmd //c`, `> log A=/c/x node`
//     -- the target ends the position; tracking "this simple command already
//     has a command word" was judged not worth the state for ~0 frequency);
//     `+=` assignment values (`A+=/c/x node`: native converts the FINAL
//     per-variable value, so a per-token rewrite diverges when another
//     assignment to the same name precedes it);
//     POSIX path arguments of native programs; envp residual value shapes
//     (see the scanner section and spec.md "envp 殘餘形").
//   HEREDOC words whose delimiter needs quote-removal/ANSI-C decoding
//     (escaped quoted forms, concatenated words like <<E"OF"): the scanner
//     cannot reproduce the terminator line, so it returns the WHOLE command
//     unchanged -- an inert miss, never a body rewrite.
//   cmd's GBK mojibake is its own case: the host's UTF-8 decode differs
//     from what a native terminal prints (strictly return != native =
//     漏修), but the faithful fix lives in the host's decode layer -- out
//     of this plugin's scope; the mojibake is the visible, self-correcting
//     signal.

import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// `define` is identity -- `export function define(plugin) { return plugin }`, read
// from the installed 2.2.5 tarball (dist/effect/plugin.js). Importing the package
// instead makes it a runtime dependency, and npm auto-installs peers: that one tree
// is 273 packages / 168 MB per install. Declared here, the plugin has no deps.
const define = <T>(plugin: T): T => plugin;

// ---- bash detection (scan + verify identity; no install paths hardcoded) --
// C:\Windows\System32\bash.exe is the WSL launcher and always sits on PATH, so
// every candidate must answer `uname -s` with an MSYS/MINGW prefix (WSL
// answers "Linux", Cygwin "CYGWIN_NT-*"; OSTYPE cannot discriminate -- Git
// Bash reports "cygwin"). Candidates: PATH scan (skipping System32), the
// install root derived from a PATH git.exe, the Git for Windows registry keys,
// then env-derived program roots. On this machine that is what it takes: the
// user PATH carries `C:\Program Files\Git\cmd` plus scoop shims (git.exe and
// git-bash.exe, no bash.exe) and there is no GitForWindows registry key, so
// the install root has to come from a PATH git.exe -- and when that git.exe is
// a scoop shim, its sibling git.shim names the real install. Verified result
// here: <git>\usr\bin\bash.exe. Nothing found -> null -> inert.

let bashCache: string | null | undefined;

const MSYS_UNAME = /^(MINGW|MSYS)/;

const GIT_REG_KEYS = [
  "HKLM\\SOFTWARE\\GitForWindows",
  "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
  "HKCU\\SOFTWARE\\GitForWindows",
];

function verifyMsysBash(candidate: string): boolean {
  const key = candidate.toLowerCase();
  const hit = msysVerified.get(key);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const p = spawnSync(candidate, ["-c", "uname -s"], { timeout: 5000, windowsHide: true });
    ok = !p.error && MSYS_UNAME.test((p.stdout?.toString() ?? "").trim());
  } catch { /* not verified */ }
  msysVerified.set(key, ok);
  return ok;
}

function registryBashRoots(): string[] {
  const roots: string[] = [];
  for (const key of GIT_REG_KEYS) {
    try {
      const p = spawnSync("reg", ["query", key, "/v", "InstallPath"], {
        timeout: 5000,
        windowsHide: true,
      });
      const m = /InstallPath\s+REG_SZ\s+(.+)/i.exec(p.stdout?.toString() ?? "");
      if (m) roots.push(m[1]!.trim());
    } catch { /* key absent or reg unavailable */ }
  }
  return roots;
}

function extraBashRoots(): string[] {
  const envRoots = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git"),
  ].filter((p): p is string => Boolean(p));
  return [...registryBashRoots(), ...envRoots];
}

function bashCandidatesFromRoot(root: string, out: string[], seen: Set<string>) {
  addCandidate(out, seen, path.join(root, "usr", "bin", "bash.exe"));
  addCandidate(out, seen, path.join(root, "bin", "bash.exe"));
}

function addCandidate(out: string[], seen: Set<string>, p: string) {
  const k = p.toLowerCase();
  if (!seen.has(k)) { seen.add(k); out.push(p); }
}

export function findBash(): string | null {
  if (bashCache !== undefined) return bashCache;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of (process.env.PATH ?? "").split(";").filter(Boolean)) {
    const base = d.replace(/[\\]+$/, "");
    if (/\\System32(\\|$)/i.test(base)) continue; // WSL launcher stub lives here
    addCandidate(out, seen, path.join(base, "bash.exe"));
    const git = path.join(base, "git.exe");
    if (!existsSync(git)) continue;
    let root = path.dirname(git); // usually <install root>\cmd
    // A shim exe only forwards; the real git.exe path lives in the sibling
    // git.shim (`path = "..."`, value may be quoted). Only a shim ON PATH
    // reaches this branch (scoop-style installs).
    const shim = path.join(root, "git.shim");
    if (existsSync(shim)) {
      try {
        const m = /^path\s*=\s*(.+)$/im.exec(readFileSync(shim, "utf8"));
        if (m) root = path.dirname(m[1]!.trim().replace(/^"+|"+$/g, ""));
      } catch { /* unreadable shim == no shim */ }
    }
    bashCandidatesFromRoot(path.dirname(root), out, seen);
  }
  for (const root of extraBashRoots()) bashCandidatesFromRoot(root, out, seen);
  for (const c of out) {
    if (existsSync(c) && verifyMsysBash(c)) { bashCache = c; return c; }
  }
  bashCache = null;
  return null;
}

// ---- the real temp anchor ------------------------------------------------
// The anchor is what the detected bash answers for /tmp (cygpath -w /tmp):
// that is the directory bash itself uses for '/tmp', so file tools and a
// command's `> /tmp/x` land together even with a custom fstab. os.tmpdir()
// is a fallback only when it is a real drive-letter path (it reads TEMP --
// an environment fact, not a guess). No anchor otherwise: the temp rewrite
// stays INERT -- never guess an AppData-style layout convention.
// Lazy: probing spawns processes (uname + cygpath, ~370ms measured) and
// module import must not pay it for calls that never touch a path.

let tempAnchor: string | null | undefined; // undefined = not probed yet; null = no anchor

export function realTempDir(): string | null {
  if (tempAnchor !== undefined) return tempAnchor;
  tempAnchor = null;
  try {
    const bash = findBash();
    if (bash) {
      const p = spawnSync(bash, ["-c", "cygpath -w /tmp"], { timeout: 5000, windowsHide: true });
      const out = (p.stdout?.toString() ?? "").trim();
      if (!p.error && /^[A-Za-z]:[\\/]/.test(out)) tempAnchor = out;
    }
  } catch { /* stay null: no anchor, no rewrite */ }
  if (tempAnchor === null) {
    const t = os.tmpdir();
    if (/^[A-Za-z]:[\\/]/.test(t)) tempAnchor = path.normalize(t);
  }
  return tempAnchor;
}

// ---- shell identity + MSYS_NO_PATHCONV probe (gate the //c rewrite) -------
// The shell hook reports the executable the host is about to spawn. Only a
// shell that verifiably answers `uname -s` with an MSYS prefix is ours; a
// config value of bash/sh is resolved through the same detection as above,
// anything else (cmd, powershell, pwsh, wsl.exe) is left alone. Results are
// cached per executable so a hook never re-probes an already-known shell.

const msysVerified = new Map<string, boolean>();
const pathConvCache = new Map<string, boolean>();

function shellCandidate(shell: string): string | null {
  if (!shell) return null;
  if (/[\\/]/.test(shell)) return existsSync(shell) ? shell : null;
  const base = shell.toLowerCase().replace(/\.exe$/, "");
  if (base !== "bash" && base !== "sh") return null;
  return findBash();
}

function isMsysShell(shell: string): boolean {
  const cand = shellCandidate(shell);
  return cand !== null && verifyMsysBash(cand);
}

export function pathConvDisabled(shell: string): boolean {
  const cand = shellCandidate(shell);
  if (!cand || !verifyMsysBash(cand)) return false;
  const key = cand.toLowerCase();
  let disabled = pathConvCache.get(key);
  if (disabled === undefined) {
    disabled = probeNoPathConv(cand);
    pathConvCache.set(key, disabled);
  }
  return disabled;
}

function probeNoPathConv(bash: string): boolean {
  try {
    // bash -c sources the user's bashrc (BASH_ENV), so the child reports
    // exactly what spawned commands will see. MSYS_NO_PATHCONV is
    // PRESENCE-based in the MSYS runtime: set to anything -- "1", "0", even
    // the empty string -- disables path conversion (measured: "=0" and "="
    // behave exactly like "=1"), so the probe tests set-at-all via ${VAR+x}
    // rather than the literal "1".
    const p = spawnSync(bash, ["-c", 'printf %s "${MSYS_NO_PATHCONV+x}"'], {
      timeout: 5000,
      windowsHide: true,
    });
    return !p.error && p.stdout?.toString().trim() === "x";
  } catch {
    return false; // uncertainty resolves to "do not rewrite"
  }
}

// A run of backslashes in the command string is folded once by the host's
// spawn channel (`\\` -> `\`) BEFORE bash parses it. `escapesNext` is whether
// the folded run has odd length -- i.e. whether bash sees the following
// character as escaped. Callers copy the ORIGINAL run verbatim and, when true,
// also copy/skip the escaped character so it is not mistaken for an opener,
// closer, or separator.
function backslashRun(s: string, i: number): { end: number; escapesNext: boolean } {
  let j = i;
  while (s[j] === "\\") j++;
  return { end: j, escapesNext: (Math.ceil((j - i) / 2) & 1) === 1 };
}

// In s, index of the ")" matching the "$(" in front of `from`; -1 if absent.
// Understands bash nesting: quotes reopen context, but $( ) and backticks
// still execute inside double quotes; single quotes are fully literal.
function matchParen(s: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const run = backslashRun(s, i);
      i = run.end + (run.escapesNext ? 1 : 0);
      continue;
    }
    if (c === "'") {
      let p = i + 1;
      while (p < s.length && s[p] !== "'") p++;
      i = p + 1;
      continue;
    }
    if (c === '"') {
      let p = i + 1;
      while (p < s.length && s[p] !== '"') {
        if (s[p] === "\\") {
          const run = backslashRun(s, p);
          p = run.end + (run.escapesNext ? 1 : 0);
          continue;
        }
        if (s[p] === "$" && s[p + 1] === "(") {
          const cl = matchParen(s, p + 2);
          if (cl === -1) return -1;
          p = cl + 1;
          continue;
        }
        if (s[p] === "`") {
          let q = p + 1;
          while (q < s.length && s[q] !== "`") {
            if (s[q] === "\\") {
              const run = backslashRun(s, q);
              q = run.end + (run.escapesNext ? 1 : 0);
              continue;
            }
            q++;
          }
          p = q + 1;
          continue;
        }
        p++;
      }
      i = p + 1;
      continue;
    }
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// The temp forms a host-side path resolver never expands: /tmp (MSYS mount)
// and the bash/cmd variables. ONE list feeds the path rewrite, the glob prefix
// split, the patch directives and the workdir rewrite -- and the same call
// returns the mechanism used for the stats key, so "value changed" and "counted"
// can never disagree (the old two-regex setup could add a form to one side only).
export type TempMechanism = "tempMount" | "tempVar";
const TEMP_FAMILIES: { mechanism: TempMechanism; re: RegExp }[] = [
  // POSIX /tmp: the host does not apply the MSYS mount mapping
  { mechanism: "tempMount", re: /^\/tmp([\\/].*)?$/i },
  // variables: the host does not expand them (bash $VAR/${VAR}, cmd %VAR%)
  { mechanism: "tempVar", re: /^\$(?:tmpdir|temp|tmp)([\\/].*)?$/i },
  { mechanism: "tempVar", re: /^\$\{(?:tmpdir|temp|tmp)\}([\\/].*)?$/i },
  { mechanism: "tempVar", re: /^%(?:temp|tmp)%([\\/].*)?$/i },
];

function splitTempPath(p: string): { mechanism: TempMechanism; rest: string } | null {
  for (const f of TEMP_FAMILIES) {
    const m = f.re.exec(p);
    if (m) return { mechanism: f.mechanism, rest: m[1] ?? "" };
  }
  return null;
}

// Classification alone (tests / callers that do not rewrite).
export function classifyTempPath(p: string): TempMechanism | null {
  return splitTempPath(p)?.mechanism ?? null;
}

// File-tool path rewrite: the temp-dir forms only. Everything else --
// relative paths, other drives, drive-letter MSYS paths (handled natively by
// OpenCode's tool layer) -- passes through untouched. Windows-only: the
// failure point is this host's Windows path resolution; on other platforms
// /tmp and $TEMP are native semantics and rewriting them would BE the side
// effect. No measured anchor -> inert (no guessed layout).
// Returns the value AND the mechanism; the hook uses the same result for the
// rewrite and the stats key (a future non-temp rewrite gets a null mechanism
// and is counted under `<surface>.other` -- visible, never mislabelled).
export function rewritePathFix(p: string): { value: string; mechanism: TempMechanism | null } {
  // checked at call time (not a captured const) so the battery can pin the
  // non-Windows behaviour with a platform override
  if (process.platform !== "win32") return { value: p, mechanism: null };
  const hit = splitTempPath(p);
  if (!hit) return { value: p, mechanism: null };
  const realTemp = realTempDir();
  if (!realTemp) return { value: p, mechanism: null };
  const tail = hit.rest.replace(/\//g, "\\").replace(/\\+$/, "");
  return { value: tail ? realTemp + tail : realTemp, mechanism: hit.mechanism };
}

// Thin value-only wrapper (existing callers/tests).
export function rewritePath(p: string): string {
  return rewritePathFix(p).value;
}

// ---- patch text: same host-side paths, written as patch directives ---------
// `patch` takes no path field: paths live inside `patchText` as `*** Add File:`,
// `*** Update File:`, `*** Delete File:` and `*** Move to:` lines. The host
// resolves those with the same Windows semantics (measured: an added
// "${TEMP}/x" landed in a literal "${TEMP}" directory under the project), so
// the same temp forms rewrite -- and only on directive lines, so patch content
// (whose lines start with ' ', '+' or '-') is never touched.
// A single patch call may contain both mechanisms; the result reports every
// mechanism actually rewritten so the hook can bump each key once (a patch is
// one tool call, not one line).

const PATCH_PATH_LINE = /^(\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: )([^\r\n]+?)(\r?)$/;

export function rewritePatchTextFix(text: string): { text: string; mechanisms: TempMechanism[] } {
  if (!text.includes("*** ")) return { text, mechanisms: [] };
  const found = new Set<TempMechanism>();
  const out = text
    .split("\n")
    .map((line) => {
      const m = PATCH_PATH_LINE.exec(line);
      if (!m) return line;
      const fix = rewritePathFix(m[2]!);
      if (fix.value === m[2]) return line;
      if (fix.mechanism) found.add(fix.mechanism);
      return m[1]! + fix.value + m[3]!;
    })
    .join("\n");
  return { text: out, mechanisms: [...found] };
}

export function rewritePatchText(text: string): string {
  return rewritePatchTextFix(text).text;
}

// A glob pattern may carry the directory itself ("${TEMP}/*.txt"). glob has no
// implicit path handling here: the literal prefix matched nothing (measured,
// 0 results -- a silent false negative), so the leading temp form moves into
// `path` and the rest stays the pattern. Only used when the call has no path,
// so a call that works today is never reshaped.
export function splitTempPrefix(pattern: string): { dir: string; rest: string; mechanism: TempMechanism } | null {
  if (process.platform !== "win32") return null;
  const hit = splitTempPath(pattern);
  if (!hit) return null;
  if (!/^[\\/].+/.test(hit.rest)) return null;
  const realTemp = realTempDir();
  if (!realTemp) return null; // no anchor: leave the pattern alone
  return { dir: realTemp, rest: hit.rest.slice(1).replace(/\\/g, "/"), mechanism: hit.mechanism };
}

// ---- shell command scan: cmd doubled flags, position-aware ----------------

// Two rewrites, one position-aware scan:
//   cmdFlag: `cmd //c|//k` -> /c|/k (the interactive-cmd failure in the
//     header). Command position is relative to a closed WORD (`echo cmd //c`
//     stays data; a standalone quoted word carries the same identity --
//     quote removal happens before the command word is parsed; the tight
//     `cmd//c` is a different word to bash and is left alone). Fires only
//     when the caller says the conversion layer is OFF (the hook probes it;
//     scanner trusts the caller -- both rewrites gate on the same convOff
//     flag, which defaults to false). Why only cmd and where the boundary
//     sits: docs/spec.md "刻意不修與漏修的分界".
//   envPath: a command-position assignment prefix with a POSIX absolute
//     path value gets the native envp conversion value. The value shapes
//     and their anchors live in convertEnvPath; the staging model in
//     pendingEnv / applyPendingEnv; the tight dynamic-tail form's
//     composition rule at the `(` branch. The measured native fact base
//     (name-agnostic grammar, drive-letter-generic anchors, the residual
//     value shapes deliberately left as misses): docs/spec.md
//     (掃描器要點 / envp 殘餘形).
// Returns flags separately (telemetry): an envPath rewrite must not be
// counted under a synthetic "rewritten !== input" heuristic as a cmd-flag fix.
export interface BashScanResult {
  command: string;
  cmdFlagFixed: boolean;
  envPathFixed: boolean;
}

// convOff defaults to FALSE: both rewrites (cmdFlag and envp) gate on the
// caller's probe verdict, so a direct call without gate evidence is a no-op
// -- uncertainty never enables a rewrite (the hook passes true only after
// pathConvDisabled has passed).
export function rewriteBashCommand(command: string, convOff = false): BashScanResult {
  return scanBash(command, convOff);
}

// Value conversion for a prefix-assignment token: reproduce the native envp
// layer's two verifiable anchors only; null = not convertible = leave it
// (uncertainty never enables a side effect).
function convertEnvPath(v: string): string | null {
  if (/[:\\]/.test(v)) return null; // list separators or cmd-isms: other rules
  let m = /^\/([a-zA-Z])(\/.*)?$/.exec(v);
  if (m) return m[1]!.toUpperCase() + ":" + (m[2] ?? "/");
  if (/^\/tmp(\/.*)?$/i.test(v)) {
    const anchor = realTempDir();
    if (!anchor) return null; // no anchor, no fix (no layout guess)
    m = /^(\/tmp)(.*)$/i.exec(v)!;
    return anchor.replace(/\\/g, "/") + m[2];
  }
  return null;
}

// A heredoc opener's delimiter word, read with bash's quote-removal rules.
// Returns the header length + delimiter + <<- marker, or:
//   null   = not a heredoc spelling we track (arithmetic shift, here-string,
//            or an ambiguous unquoted word: pure digits / leading punctuation)
//   "bail" = a legal heredoc word whose delimiter cannot be decoded statically
//            (quoted form containing backslash escapes, quoted/unquoted word
//            concatenation). The caller then leaves the WHOLE command
//            unchanged: rewriting inside a body is silent data corruption,
//            a missed fix is the safe direction (寧可漏修，不可誤修).
// Delimiters are bash WORDS, not just identifiers: quoted content may contain
// spaces; `$'...'`/`$"..."` are legal too; an unquoted word may carry digits
// after a letter/_/non-ASCII head (`<<2EOF`, `<<EOF.v2`), while a pure-digit or
// ASCII-punctuation head stays untracked (it is statically indistinguishable
// from `$((x<<2))` -- docs/spec.md records the boundary).
type HeredocHead = { len: number; delim: string; dash: boolean };
function readHeredocHead(s: string, from: number): HeredocHead | "bail" | null {
  let i = from + 2;
  const dash = s[i] === "-";
  if (dash) i++;
  while (s[i] === " " || s[i] === "\t") i++;
  // Leading backslash run before the word: the transport fold + lexer make
  // 1-2 backslashes a quote marker (`<<\EOF` / `<<\\EOF` -> delimiter EOF), a
  // longer run leaves a literal backslash in the word. Anything past two is
  // not reproducible here -> bail (never scan a body).
  const lead = backslashRun(s, i);
  const marker = lead.end > i;
  if (marker) {
    if (lead.end - i > 2) return "bail";
    i = lead.end;
  }
  const c = s[i];
  if (marker && (c === "'" || c === '"' || c === "$")) return "bail"; // <<\'x' etc.
  const ansi = c === "$" && (s[i + 1] === "'" || s[i + 1] === '"');
  const quote = ansi ? s[i + 1] : c;
  if (quote === "'" || quote === '"') {
    const start = ansi ? i + 2 : i + 1;
    let j = start;
    let escaped = false;
    while (j < s.length && s[j] !== quote) {
      if (s[j] === "\n") return "bail";
      // Backslash escapes the closing quote in double quotes and in ANSI-C
      // quotes; in a plain single-quoted word it is an ordinary character.
      if ((quote === '"' || ansi) && s[j] === "\\") {
        const run = backslashRun(s, j);
        escaped = true;
        j = run.end + (run.escapesNext ? 1 : 0);
        continue;
      }
      j++;
    }
    if (j >= s.length) return "bail";
    if (escaped) return "bail"; // quote removal changes the delimiter: do not guess
    // A quoted word can continue with more chars (`<<"A"B`, `<<'A'/x`,
    // `<<'A'#x`): the delimiter is the concatenation, not the quoted part.
    // Only a real separator ends a heredoc word.
    if (!/[\s;&|<>()]/.test(s[j + 1] ?? " ")) return "bail";
    // The spawn channel folds each `\\` pair BEFORE bash sees the line, and a
    // plain single-quoted word is otherwise literal. Fold the content so the
    // body's terminator comparison uses the same bytes bash receives.
    const content = s.slice(start, j);
    const delim = quote === "'" && !ansi ? content.replace(/\\\\/g, "\\") : content;
    return { len: j + 1 - from, delim, dash };
  }
  const m = /^(\d*[A-Za-z_\u0080-\uFFFF][^\s"'><;&|()\\`]*)/.exec(s.slice(i));
  if (!m) return null;
  const end = i + m[1].length;
  // A following quote/backslash continues the same word after quote removal
  // (`<<E"OF"`, `<<E\OF`): the literal prefix is not the delimiter.
  if (s[end] === "\\" || s[end] === '"' || s[end] === "'") return "bail";
  return { len: end - from, delim: m[1], dash };
}

function scanBash(command: string, convOff = false): BashScanResult {
  // heredoc bodies are data: one queue entry per opener on the current header
  // line, consumed in bash's order (multiple heredocs on one line are legal:
  // `cat <<A <<B` -- a single-slot tracker ended the first body at a line
  // equal to B and rewrote the second body's `cmd //c`, measured corruption).
  const heredocs: { delim: string; dash: boolean }[] = [];
  const cmdFlag = /\/\/([A-Za-z]+)(?![\w.\-/])/iy; // cmd flags are alphabetic and never cross a "/": /v:on keeps its colon tail, and a "/" after the flag word means no flag spelling at all (UNC `//server/share`, `//c/d/e` -- a "/" in the terminator class keeps them unrewritten; a following "//" pair is blocked by the non-empty curTok, measured)
  let out = "";
  let i = 0;
  const n = command.length;
  let inHeader = false;
  // token tracking: only rewrite flags of a cmd in COMMAND position, never
  // literal data (`echo cmd //c` stays verbatim)
  let curTok = "";
  let prevTok = "";
  let prevTokCmdPos = false;
  // whether prevTok came from a quote-fed word (isCmdTok must not unescape a
  // quoted word: inside double quotes a backslash before a normal char stays)
  let prevTokQuoted = false;
  let cmdPosNext = true;
  let cmdFlagZone = false; // after cmd, /flags keep the zone alive (cmd //q //c)
  let cmdFlagFixed = false;
  let envPathFixed = false;
  // whether the CURRENT token's content came from a quote-fed word: a quoted
  // word carries its quotes in `out`, so the span arithmetic (out.length -
  // curTok.length) would be wrong for it -- and bash's assignment-prefix rule
  // runs before quote removal, so `"B=/c/y"` is a command word, not a prefix
  // (measured 127). Set by the quote branches, consumed by commitTok.
  let tokQuoted = false;
  // Prefix-assignment path rewrite: assignment tokens in command position are
  // staged (span in `out` + converted word); applied only when a real command
  // word of the SAME simple command lands. Applied right-to-left (spans stay
  // valid: later appends only grow the string after the earlier span).
  const pendingEnv: { start: number; end: number; rep: string }[] = [];
  // envp trigger predicates -- deliberately CASE-SENSITIVE here (bash
  // keywords are lowercase, so ENV/ECHO uppercase are program names and must
  // apply like any native command; the cmd-flag face below keeps its own
  // historical case-insensitive set, untouched). One shared predicate for all
  // three decision points (staging? keeper apply / apply on word / EOF) --
  // fd tokens (2>&1's "2", pure digits) and empty assignments (B=) are NOT
  // real command words: measured native behaviour persists the value of
  // `A=/c/x 2>&1` unconverted.
  const RESERVED_WORD = /^(?:if|then|elif|else|fi|while|until|do|done|time|exec|command|builtin|env|[{}!])$/;
  // Real-command-word exclusion set -- command words whose value never
  // crosses the msys->native exec boundary, two closed classes:
  // 1) bash builtins (enumerable via `enable -a`, plus . [ [[ ]] special
  //    words); the special builtins eval/source/`.` spawn natively IN their
  //    dynamic scope WITH conversion (measured `A=/c/x eval 'node …'` ->
  //    C:/x) so excluding them leaves that side a miss (native-safe).
  // 2) bash/sh: MSYS programs; msys->msys exec does not convert envp (measured
  //    `A=/c/x bash -c 'echo $A'` -> /c/x); a native spawn INSIDE converts at
  //    that inner boundary -- a miss again, safe direction.
  // exec/command/env deliberately NOT here: they continue position via
  // RESERVED_WORD and the word after them applies (command node / env node
  // is a native boundary).
  // Anti-drift: the battery asserts this set against `enable -a` one by one.
  const BUILTIN_WORD = /^(?:\.|:|\[|\[\[|\]\]|alias|bg|bind|break|builtin|bash|caller|cd|compgen|compopt|complete|continue|declare|dirs|disown|echo|enable|eval|exit|export|false|fc|fg|getopts|hash|help|history|jobs|kill|let|local|logout|mapfile|popd|printf|pushd|pwd|read|readarray|readonly|return|set|sh|shift|shopt|source|suspend|test|times|trap|true|type|typeset|ulimit|umask|unalias|unset|wait)$/;
  const ASSIGN_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
  const envpTrigger = (t: string) =>
    !ASSIGN_PREFIX.test(t) && !RESERVED_WORD.test(t) && !BUILTIN_WORD.test(t) && !/^\d+$/.test(t);

  // Apply the staged assignment rewrite. Gate re-check: when the caller says
  // conversion is ON, the native layer does this itself and the rewrite would
  // be duplicate protection (pure side effect) -- drop the staged spans.
  const applyPendingEnv = () => {
    if (!pendingEnv.length) return;
    if (!convOff) { pendingEnv.length = 0; return; }
    for (let k = pendingEnv.length - 1; k >= 0; k--) {
      const r = pendingEnv[k];
      out = out.slice(0, r.start) + r.rep + out.slice(r.end);
    }
    envPathFixed = true;
    pendingEnv.length = 0;
  };
  let inBacktick = false; // flat backtick nesting (\` is eaten by the escape branch)
  const btPos: boolean[] = []; // outer command position to restore at each closing backtick
  // open parens, each remembering the OUTER command position at open time:
  // "subst" = $(, "procsubst" = <( / >(, "func" = foo(, "case" = a
  // "( pattern" wrapper inside a case pattern region, "group" = everything
  // else; a ")" restores accordingly (func/case always keep the position).
  // The kind also decides word continuation after ")": substitutions
  // (including process substitution, measured `echo <(true)#x` -> "#x" is a
  // literal tail) continue the word, group/subshell/function closes start a
  // new one.
  const parenStack: { kind: string; pos: boolean }[] = [];
  // whether the LAST ")" continued the WORD it closed (word continues past
  // "$(pwd)" and "<(pwd)": "#" stays literal, measured) -- a group/subshell/
  // function/arithmetic-command ")" starts a new word instead ((true)#,
  // ((1))#, f()# are comments, measured), as does a case-PATTERN ")".
  let parenContinuesWord = false;
  // positions of a "$" consumed as an \$ escape pair: that "$" is LITERAL, so
  // a "(" right after it never opens a substitution (bash parses it as a
  // syntax error) -- the paren classifier must not see it as an opener
  const escapedDollar = new Set<number>();
  // case tracking: "case" (command position) arms it, the case's "in" starts
  // the PATTERN region -- its ")" terminates the pattern and opens the body
  // -- ";;" returns to the pattern region and "esac" ends it, but only at
  // COMMAND position (a data-position `esac`, `echo esac`, is an argument and
  // does not end the section: measured, otherwise the next pattern ")" steals
  // the enclosing substitution's stack entry and `cmd //c` inside
  // `echo $(case … echo esac;; b) cmd //c …)` is missed). The region decides
  // what a ")" closes: a pattern ")" has no matching "(" (popping on it steals
  // the enclosing substitution's stack entry), while a $( ) in the BODY is an
  // ordinary paren and must pop normally.
  let caseRegion: "none" | "pattern" | "body" = "none";
  let casePending = false; // saw "case", waiting for the case's "in"

  // A cmd token is recognised by basename. Unquoted words pass through TWO
  // layers on this host (both measured live 2026-11-04): the spawn channel
  // folds each `\\` pair to one backslash, then bash's unquoted lexer removes
  // one more escape level. So event.command `C:\Windows\…` (1) and
  // `C:\\Windows\\…` (2) both end up as C:Windows… (127, untouched), while 3/4
  // backslashes end up as C:\Windows\… (a REAL program that runs cmd) and are
  // rewritten. `\cmd`/`c\md` (1) and `c\\md` (2) run cmd; 3+ backslashes leave
  // a literal \ in the word (127). pi's transport folds the same way but its
  // isCmdTok removes every backslash, which is why this model is oc-specific.
  // A QUOTED word is different: backslashes are literal, and MSYS
  // resolves them as separators when the path exists -- `"C:\Windows\…\cmd.exe"`
  // and `"/c/Windows\System32\cmd.exe"` both run cmd (measured), so keep the
  // raw quoted word (a quoted `"c\md"` basename is `md`, not cmd).
  const isCmdTok = (t: string, quoted = false) => {
    // a trailing escape pair in an unquoted word (`cmd\\ <space>`) folds into a
    // lone backslash that escapes the delimiter; bash then sees `cmd <space>`
    // (or `cmd <stuff>` as one word) -- not the program (measured 127). Refuse
    // rather than rely on the unescape approximation.
    if (!quoted && /\\$/.test(t)) return false;
    const word = quoted ? t : t.replace(/\\\\/g, "\\").replace(/\\([\s\S])/g, "$1");
    const base = word.split(/[\\/]/).pop()!.toLowerCase();
    return base === "cmd" || base === "cmd.exe";
  };

  // A word after these starts a COMMAND WORD (the next word is executed).
  // Deliberately excludes words whose next slot is DATA or END-OF-CONSTRUCT:
  //   data slots: case SUBJECT, `in` list, for/select variable, function name
  //   terminators: fi, done, esac, `}` (a command after them needs `;`/`&&`/newline)
  // Keeping those in would let a data word arm the cmd-flag zone
  // (`for cmd in …`, `case cmd in …`) or rewrite dead text (`{ …; } cmd`,
  // `fi cmd`) -- both measured/zero-effect (details in spec).
  const COMMAND_POS_CONTINUES = new Set([
    "if", "then", "else", "elif", "while", "until", "do",
    "time", "exec", "command", "builtin", "env", "!", "{",
  ]);
  // A function definition's body must be a COMPOUND command; `f() cmd` is a
  // syntax error (measured). After `f()` we defer the position until the next
  // token: a compound starter opens the body (cmd inside is rewritten), a
  // simple word does not (dead text stays untouched). `(`/`((` are handled by
  // the paren branch; `[[` and the compound keywords are tokens.
  const FUNC_BODY_STARTERS = new Set(["{", "if", "while", "until", "for", "case", "select", "[["]);
  let funcAwaitBody = false;

  // a close or separator starts a fresh token context: tokens from INSIDE a
  // substitution must not authorize a rewrite outside it ("echo $(cmd) //x"
  // -- //x is echo's argument, not a cmd flag)
  const clearTok = () => {
    prevTok = "";
    prevTokCmdPos = false;
    prevTokQuoted = false;
    cmdFlagZone = false;
  };

  const commitTok = () => {
    // the quote-fed marker covers only the token it fed: take it first and
    // clear it even on the empty-content early return (`""` is a fed empty
    // word, whose quotes are in `out` but not in curTok)
    const quotedTok = tokQuoted;
    tokQuoted = false;
    if (!curTok) return;
    prevTokCmdPos = cmdPosNext;
    if (cmdPosNext) {
      // FOO=bar env prefixes and command-leading keywords do not end the
      // position (see COMMAND_POS_CONTINUES)
      cmdPosNext =
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(curTok) || COMMAND_POS_CONTINUES.has(curTok.toLowerCase());
    }
    // function body: only a compound starter continues the command position
    const low = curTok.toLowerCase();
    if (funcAwaitBody) {
      const startsBody = FUNC_BODY_STARTERS.has(low);
      // the starter itself is the first token of the body: give it command
      // position too (the case tracker needs `case` to be at command position)
      if (startsBody) prevTokCmdPos = true;
      cmdPosNext = startsBody;
      funcAwaitBody = false;
    }
    // case-region tracking (see the declaration above for the grammar)
    if (low === "case" && prevTokCmdPos) casePending = true;
    else if (low === "in" && casePending) {
      caseRegion = "pattern";
      casePending = false;
    } else if (low === "esac" && !quotedTok && !casePending && (caseRegion === "pattern" || prevTokCmdPos)) {
      // bare `esac` terminates the case:
      //  - in the PATTERN region it is the empty-case terminator
      //    (`case x in esac` is valid and its closing ")" is the enclosing
      //    $() close, not a pattern ")" -- measured: `echo $(case x in esac)
      //    cmd //c` prints the data, so rewriting there is a real misfix);
      //  - in the BODY/`none` it needs command position (a data `echo esac`
      //    does not end the section: measured, otherwise the next pattern ")"
      //    steals the enclosing substitution's stack entry).
      // Not a terminator when it is the case SUBJECT (`case esac in …`),
      // a QUOTED pattern literal (`case esac in "esac") …`), or a data word.
      caseRegion = "none";
      casePending = false;
    }
    if (cmdFlagZone && !curTok.startsWith("/")) cmdFlagZone = false;
    // `builtin cmd` is not a program: `builtin` looks the next word up in the
    // builtin table, cmd is not a builtin, so bash fails before spawning
    // anything -- rewriting its `//c` changes only dead text (measured; the
    // word after builtin can still execute through builtin exec/command/eval/
    // source, and those reach this line with prevTok = that builtin, not
    // "builtin"). Same rule as the other zero-effect rewrites.
    if (prevTok === "builtin" && isCmdTok(curTok, quotedTok)) prevTokCmdPos = false;
    if (prevTokCmdPos && isCmdTok(curTok, quotedTok)) cmdFlagZone = true;
    // prefix-assignment staging / apply (envp): the assignment token (whole
    // word, unquoted) in command position is staged; a later real command
    // word (non-assignment incl. empty-value, non-keyword, non-builtin,
    // non-pure-digit) landing in the SAME simple command means the value will
    // enter that command's environment -- apply. Empty-value assignments
    // neither stage (nothing convertible) nor trigger apply (see
    // envpTrigger). prevTokCmdPos here is still THIS token's position.
    if (prevTokCmdPos) {
      if (ASSIGN_PREFIX.test(curTok)) {
        if (quotedTok) {
          // A quote-fed word is NOT a bash assignment prefix (the prefix rule
          // runs before quote removal): native executes it as the command
          // word (`A=/c/x "B=/c/y" node` -> `B=/c/y: No such file or
          // directory`, 127). Do not stage; and never take the span path --
          // curTok is not a tail of `out` for a quoted word (its quotes are).
          cmdPosNext = false;
        } else if (/^(?:exec|command|builtin)$/.test(prevTok)) {
          // exec/command/builtin take the next word as their ARGUMENT: bash
          // runs `X=/c/x` as a command name (measured 127/127/1, same message
          // in both conversion states) -- the value reaches no envp, so do not
          // stage and end the position like an ordinary word. `env` is NOT
          // here: it is a POSIX external program, and its X= argument crosses
          // the msys->native boundary (measured env X=/c/x node -> C:/x).
          cmdPosNext = false;
        } else {
          const em = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(curTok);
          if (em) {
            const conv = convertEnvPath(em[2]!);
            if (conv) pendingEnv.push({ start: out.length - curTok.length, end: out.length, rep: em[1]! + "=" + conv });
          }
        }
      } else if (envpTrigger(curTok)) {
        applyPendingEnv();
      }
    }
    prevTok = curTok;
    prevTokQuoted = quotedTok;
    curTok = "";
  };

  // $( ) and `...` execute inside double quotes too: recurse into them.
  // Escape pairs are consumed as pairs: "\$" makes the $ literal (a "(" after
  // it is data, never a substitution opener -- bash: "\$(x)" prints $(x)),
  // while "\\" is a literal backslash and the $( after it is a REAL
  // substitution (bash: "\\$(pwd)" prints "\<pwd>"); the pair skip keeps both
  // sides straight (before it, the literal "\$( )" interior was scanned and
  // rewritten -- a silent misfix of echo's data).
  const scanDq = (seg: string): string => {
    let s = "";
    let k = 0;
    const m2 = seg.length;
    while (k < m2) {
      const c = seg[k];
      if (c === "\\") {
        const run = backslashRun(seg, k);
        const end = Math.min(run.end + (run.escapesNext ? 1 : 0), m2);
        s += seg.slice(k, end);
        k = end;
        continue;
      }
      if (c === "$" && seg[k + 1] === "(") {
        const close = matchParen(seg, k + 2);
        if (close === -1) { s += seg.slice(k); break; }
        const sub = scanBash(seg.slice(k + 2, close), convOff);
        s += "$(" + sub.command + ")";
        cmdFlagFixed ||= sub.cmdFlagFixed;
        envPathFixed ||= sub.envPathFixed;
        k = close + 1;
        continue;
      }
      if (c === "`") {
        let p = k + 1;
        while (p < m2 && seg[p] !== "`") {
          if (seg[p] === "\\") {
            const run = backslashRun(seg, p);
            p = run.end + (run.escapesNext ? 1 : 0);
            continue;
          }
          p++;
        }
        if (p >= m2) { s += seg.slice(k); break; }
        const sub = scanBash(seg.slice(k + 1, p), convOff);
        s += "`" + sub.command + "`";
        cmdFlagFixed ||= sub.cmdFlagFixed;
        envPathFixed ||= sub.envPathFixed;
        k = p + 1;
        continue;
      }
      s += c;
      k++;
    }
    return s;
  };

  while (i < n) {
    // heredoc bodies are data: copy verbatim; each delimiter line ends its
    // body (in opener order). (Unquoted bodies still undergo $( )/backtick
    // expansion in bash; those inner commands are deliberately NOT rewritten
    // -- a loud miss beats scanning inside body data.)
    if (heredocs.length && !inHeader) {
      let lineEnd = command.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = n;
      // bash matches the terminator line EXACTLY (<<- strips leading tabs
      // only, nothing else) -- a trim() here would end the body early and
      // rewrite its lines ("EOF " / "  EOF" are BODY) -- except that ONE
      // trailing \r is ignored: measured, both a full-CRLF text and a clean
      // delimiter followed by an "EOF\r" line terminate the body here. The
      // transport fold (`\\` -> `\`) applies to the body bytes too, so fold
      // both sides before comparing a delimiter that contains backslashes.
      const raw = command.slice(i, lineEnd).replace(/\r$/, "").replace(/\\\\/g, "\\");
      const head = heredocs[0]!;
      if ((head.dash ? raw.replace(/^\t+/, "") : raw) === head.delim) {
        out += command.slice(i, Math.min(lineEnd + 1, n));
        i = lineEnd + 1;
        heredocs.shift();
        if (!heredocs.length) {
          curTok = "";
          clearTok();
          cmdPosNext = true; // all bodies consumed: a fresh command line follows
        }
        continue;
      }
      out += command.slice(i, Math.min(lineEnd + 1, n));
      i = lineEnd + 1;
      continue;
    }
    const ch = command[i];
    if (ch === "\n" && heredocs.length && inHeader) {
      out += "\n";
      i++;
      inHeader = false;
      curTok = "";
      clearTok();
      continue;
    }
    if (ch === "\\") {
      const run = backslashRun(command, i);
      const end = Math.min(run.end + (run.escapesNext ? 1 : 0), n);
      const seg = command.slice(i, end);
      out += seg;
      curTok += seg; // escaped chars belong to the token (\> is no operator)
      if (run.escapesNext && command[run.end] === "$") escapedDollar.add(run.end); // \$: the $ is literal (see escapedDollar)
      i = end;
      continue;
    }
    if (ch === "'") {
      // ANSI-C quoting ($'...'): the content is literal (no command
      // substitution) and a backslash escapes the next character -- including
      // \' -- so the plain single-quote scan would end at the escaped quote and
      // treat the rest of the string as shell syntax (measured: `echo $'x\' ;
      // cmd //c ver'` rewrote the echoed data). Copy the whole segment
      // verbatim; feed the token only when it has no escapes, since only then
      // the quote-removed content is known statically.
      const ansiC =
        command[i - 1] === "$" && !escapedDollar.has(i - 1) && command[i - 2] !== "$";
      // A quote does not change word identity (bash removes quotes before
      // parsing the command word). A standalone quoted word in command
      // position is fed to the token; without it the NEXT word was taken as
      // the command word and applied a staged assignment (`A=/c/x "bash" -c
      // …` rewrote A although native keeps /c/x in both conversion states --
      // a silent misfix). Quotes inside a word (A="…", ba"sh") stay
      // invisible: value-quote shapes are ledger misses and an in-word split
      // is not a reliable identity.
      const feedTok = curTok === "" && cmdPosNext;
      commitTok();
      funcAwaitBody = false; // a quoted word is not a function body
      if (ansiC) {
        let end = i + 1;
        while (end < n && command[end] !== "'") {
          if (command[end] === "\\") {
            const run = backslashRun(command, end);
            end = run.end + (run.escapesNext ? 1 : 0);
            continue;
          }
          end++;
        }
        if (end >= n) { out += command.slice(i); break; }
        out += command.slice(i, end + 1);
        const content = command.slice(i + 1, end);
        if (feedTok && !content.includes("\\")) { curTok += content; tokQuoted = true; }
        i = end + 1;
        continue;
      }
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        const seg = command.slice(i);
        out += seg;
        if (feedTok) { curTok += command.slice(i + 1); tokQuoted = true; }
        break;
      }
      const seg = command.slice(i, end + 1);
      out += seg;
      if (feedTok) { curTok += command.slice(i + 1, end); tokQuoted = true; }
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      // same feed rule as the single-quote branch. Content with $( )/backticks/
      // escapes matches no closed set -- the safe direction, same as a dynamic
      // word.
      const feedTok = curTok === "" && cmdPosNext;
      commitTok();
      funcAwaitBody = false; // a quoted word is not a function body
      // closing quote hunt: $() and backticks reopen quote context
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") {
          const run = backslashRun(command, j);
          j = run.end + (run.escapesNext ? 1 : 0);
          continue;
        }
        if (command[j] === "$" && command[j + 1] === "(") {
          const close = matchParen(command, j + 2);
          if (close === -1) { j = n; break; }
          j = close + 1;
          continue;
        }
        if (command[j] === "`") {
          let p = j + 1;
          while (p < n && command[p] !== "`") {
            if (command[p] === "\\") {
              const run = backslashRun(command, p);
              p = run.end + (run.escapesNext ? 1 : 0);
              continue;
            }
            p++;
          }
          j = p + 1;
          continue;
        }
        j++;
      }
      if (j >= n) {
        const seg = command.slice(i);
        out += scanDq(seg); // $( ) inside an unclosed quote still executes
        if (feedTok) { curTok += command.slice(i + 1); tokQuoted = true; }
        break;
      }
      const seg = command.slice(i, j + 1);
      out += scanDq(seg);
      if (feedTok) { curTok += command.slice(i + 1, j); tokQuoted = true; }
      i = j + 1;
      continue;
    }
    // Here-string `<<<`: one redirection token. Processing its second/third
    // "<" separately made `<<< "$(cmd //c ver)"` look like a heredoc opener
    // (`<< "$(…)"`), so the real command substitution inside the quoted word
    // was never scanned (measured: native executes it, the flag stayed //c).
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
      commitTok();
      funcAwaitBody = false;
      cmdPosNext = false;
      clearTok();
      pendingEnv.length = 0; // a redirect ends the staged prefix here (a command word after it is the documented redirect-prefix miss)
      out += "<<<";
      i += 3;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      commitTok();
      funcAwaitBody = false; // a heredoc is not a function body
      const head = readHeredocHead(command, i);
      // An undecodable delimiter means the body boundary is unknown; keeping
      // the original command is the only way to stay out of the body's data.
      if (head === "bail") return { command, cmdFlagFixed: false, envPathFixed: false };
      if (head) {
        heredocs.push({ delim: head.delim, dash: head.dash });
        inHeader = true;
        pendingEnv.length = 0; // a heredoc redirect ends the staged prefix here; `A=x <<EOF cmd` is the documented redirect-prefix miss (inert, safe)
        out += command.slice(i, i + head.len);
        i += head.len;
        continue; // same-line redirects still scanned (cmd flag detection needs them)
      }
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      commitTok();
      if (ch === "\n") {
        cmdPosNext = true;
        clearTok(); // a new command line: no token authorizes anything
        pendingEnv.length = 0; // new command line = assignment without a command word (standalone) -> discard
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "(") {
      commitTok();
      funcAwaitBody = false; // a separator or the paren-as-body settles the slot
      // ";;" and ";&" both end the body (bash case terminators); ";;&" is
      // covered by its leading ";;". Without ";&" the next pattern ")" was
      // treated as an ordinary paren close and the following body's cmd flag
      // stayed unrewritten (a miss).
      if (ch === ";" && caseRegion === "body" && (command[i + 1] === ";" || command[i + 1] === "&")) {
        caseRegion = "pattern"; // ";;" / ";&" end the body: the next pattern follows
      }
      if (ch === "(") {
        // classify the paren and remember the OUTER command position at open
        // time: $( opens a substitution, <( / >( a process substitution,
        // foo( is a function definition ("{ cmd" follows), a "( pattern"
        // wrapper inside a case PATTERN region is closed by the pattern's ")",
        // anything else is a group / subshell opener. The saved position
        // decides what the closing ")" restores: "count=$(...) cmd" opened
        // from an assignment prefix (position alive -- bash runs cmd), while
        // "echo $(...) cmd" opened from an argument (cmd is data). A "$"
        // consumed as \$ is literal (the "(" after it is a bash syntax error),
        // so it never classifies as a substitution opener (escapedDollar).
        const kind =
          caseRegion === "pattern"
            ? "case"
            : command[i - 1] === "$" && !escapedDollar.has(i - 1)
              ? "subst"
              : /[A-Za-z0-9_]/.test(command[i - 1] ?? "")
                ? "func"
                : command[i - 1] === "<" || command[i - 1] === ">"
                  ? "procsubst"
                  : "group";
        parenStack.push({ kind, pos: cmdPosNext });
      }
      // pipeline / command end : the staged assignment never met a real
      // command word of its simple command (standalone -> bash-side variable,
      // POSIX value kept). `(` does NOT drop: the tight form
      // `VAR=/c/x$(...)` is still collecting its value's dynamic tail, and
      // `A=x (...)` is a syntax error -- no legal shape to protect.
      if (ch === "|" || ch === ";") pendingEnv.length = 0;
      clearTok();
      cmdPosNext = true; // separators open a new command position
      out += ch;
      i++;
      continue;
    }
    if (ch === "&") {
      commitTok();
      funcAwaitBody = false;
      if (command[i - 1] !== ">" && command[i - 1] !== "<") {
        cmdPosNext = true; // 2>&1's & is no separator
        clearTok();
        pendingEnv.length = 0; // background split: the assignment is a standalone
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === ">" || ch === "<") {
      commitTok();
      funcAwaitBody = false; // a close/redirect is not a function body
      // whether the close RESTORES a command position still owed its command
      // word (the tight form `VAR=/c/x$(pwd) node` closes the assignment
      // value here): it keeps the staged assignment so the following word
      // applies it. Redirection targets are bash's own path syntax (never
      // argv envp) and `)` ends the command: both discard.
      let restoreTrue = false;
      if (ch === ")") {
        if (caseRegion === "pattern") {
          // the case-PATTERN terminator: no matching "(" of its own, so it
          // must not pop the paren stack (that would steal the ENCLOSING
          // substitution's entry -- "echo $(case 1 in 1) x;; esac) cmd //c
          // ver", where cmd is echo's argument). It closes the optional
          // "( pattern" wrapper only, and the body (a command list) starts:
          // command position. A new WORD begins after it ("a)#c" is a
          // comment, measured).
          if (parenStack.length && parenStack[parenStack.length - 1]!.kind === "case") {
            parenStack.pop();
          }
          cmdPosNext = true;
          caseRegion = "body";
          parenContinuesWord = false;
        } else {
          // an ordinary paren close -- also inside a case BODY: the ")" of
          // "case x in a) echo $(pwd) cmd" must pop, leaving cmd as echo's
          // argument. Restore what the matching "(" saved: "count=$(...)
          // cmd" (assignment prefix -- bash runs cmd) keeps the position,
          // "echo $(...) cmd" ends it; "foo()" keeps it. A GROUP/subshell
          // close does NOT reopen a command position: `( … ) word` is a bash
          // syntax error (measured), so rewriting `cmd //c` there is dead
          // text. A stray ")" is a syntax error too -- stay inert.
          const fr = parenStack.pop();
          if (fr === undefined || fr.kind === "group") {
            cmdPosNext = false;
          } else if (fr.kind === "func") {
            // a function body must be a compound command: defer the position
            // to the next token (see FUNC_BODY_STARTERS)
            cmdPosNext = false;
            funcAwaitBody = true;
          } else if (fr.kind === "case") {
            cmdPosNext = true;
          } else {
            cmdPosNext = fr.pos;
          }
          restoreTrue = fr !== undefined && (fr.kind === "func" || (fr.kind === "subst" && fr.pos === true));
          // Word continuation after ")" (measured): a substitution close --
          // $( ), $(( )) and <( )/>( ) -- continues the word, so "#" stays
          // literal; a group/subshell/function/arithmetic-command close starts
          // a new word, so the next "#" is a COMMENT (dead text, never
          // rewritten). A stray ")" (bash syntax error) keeps the old
          // continuation to avoid inventing a rule for dead input.
          parenContinuesWord =
            fr === undefined ? true : fr.kind === "subst" || fr.kind === "procsubst";
        }
        clearTok();
      } else {
        // a redirect target is not a command position and must not authorize
        // one either: "cmd > //out" -- the target is bash's own path syntax
        // and native "> //x" is a loud failure we leave alone
        cmdPosNext = false;
        clearTok();
      }
      if (!restoreTrue) pendingEnv.length = 0;
      out += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      // a mid-word backtick (x=`y`) vs a standalone word (`echo `y``): the
      // words after a standalone substitution are its command's ARGUMENTS,
      // while a substitution inside an assignment word (x=`y`) is followed
      // by a real command position
      const inWord = curTok !== "";
      commitTok();
      funcAwaitBody = false; // a substitution is not a function body
      if (!inBacktick) {
        // opening: command position inside; remember whether the enclosing
        // word is an assignment prefix ("x=`y` cmd //c" -- bash runs cmd)
        btPos.push(inWord && cmdPosNext);
        inBacktick = true;
        cmdPosNext = true;
      } else {
        // closing: restore what the enclosing word deserves
        inBacktick = false;
        cmdPosNext = btPos.length ? btPos.pop()! : false;
      }
      clearTok();
      out += ch;
      i++;
      continue;
    }
    // cmd doubled flags: only when `cmd` is a CLOSED word in command position
    // (a space always separates the flag from the program name).
    // Gated on convOff like the envp rewrite: with conversion ON the native
    // layer converts //c itself, and a rewrite would BE the side effect.
    // The tight spelling cmd//c is a different word to bash (a program name),
    // so it is deliberately NOT rewritten: natively it fails loudly
    // (`No such file or directory`, 127) in both conversion states -- a model
    // typo, not an environment fault (spec.md deliberate-no-fix).
    if (convOff && ch === "/" && command[i + 1] === "/") {
      const atCmd =
        curTok === "" &&
        ((prevTokCmdPos && isCmdTok(prevTok, prevTokQuoted)) || (cmdFlagZone && prevTok.startsWith("/")));
      if (atCmd) {
        cmdFlag.lastIndex = i;
        const m = cmdFlag.exec(command);
        if (m) {
          out += "/" + m[1];
          i += m[0].length;
          curTok = "/" + m[1];
          cmdFlagFixed = true;
          continue;
        }
      }
      curTok += ch;
      out += ch;
      i++;
      continue;
    }
    // a `#` at the head of a WORD is a comment: bash ignores the rest of the
    // line, so comment text is dead data that can never reach any program --
    // copy it verbatim to end of line, like a heredoc body. (Before this, the
    // comment was tokenized: a "(" inside was classified as a function
    // definition and reopened command position, so `cmd //c ver # note (cmd
    // //x)` rewrote INSIDE the comment -- a zero-effect misfix: every rewrite
    // must name a fault point, and dead text reaches none.) Word head per
    // bash's own lexer rule -- input start or after a blank/operator. The
    // word CONTINUES after a quote close ("a"#b keeps the # literal) and after
    // a substitution close ($(pwd)#z, <(pwd)#z keep it too, measured); group/
    // subshell/function/arithmetic-command ")") and a case-PATTERN ")" start a
    // new word ((true)#c, a)#c are comments, measured). The staged assignment
    // ends here as a bash-side standalone (dropped BEFORE this `#` commits --
    // at word head in command position it would otherwise count as the command
    // word and wrongly apply). `#` mid-word (a#b) is data, untouched. The
    // trailing \n is left to the whitespace branch so the next line starts a
    // fresh command context.
    const atWordHead =
      out === "" ||
      " \t\n;|&(<>".includes(out[out.length - 1]!) ||
      (out.endsWith(")") && !parenContinuesWord);
    if (ch === "#" && curTok === "" && atWordHead) {
      pendingEnv.length = 0;
      let lineEnd = command.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = n;
      out += command.slice(i, lineEnd);
      i = lineEnd;
      continue;
    }
    curTok += ch;
    out += ch;
    i++;
  }
  // EOF close: the last token never sees a separator to commit it -- a real
  // command word at the tail applies the staged assignments exactly like the
  // mid-command path (`A=/c/x cmd` ends here); an assignment (incl. empty
  // value), keyword, builtin or pure-digit tail is a standalone -> discard.
  if (curTok && cmdPosNext && envpTrigger(curTok)) applyPendingEnv();
  return { command: out, cmdFlagFixed, envPathFixed };
}

// ---- OpenCode hook wiring -------------------------------------------------
// Two hooks, each on the boundary where the environment breaks the command
// (wiring facts -- inputs are mutable and both mutations land on the spawned
// command line, measured on v2.2.5 -- are in docs/spec.md〈oc 版：接線與閘門〉):
//   ctx.shell.hook("create.before") -> event.command (the exact string the host
//     hands to the shell) and event.cwd (the shell's `workdir`, still
//     unresolved here). `shell` names the executable it will spawn, so both
//     rewrites are gated on that shell being a verified MSYS bash; the //c
//     rewrite additionally needs the MSYS_NO_PATHCONV probe.
//   ctx.tool.hook("execute.before") -> event.input for the file tools: `path`,
//     plus `patch.patchText` (paths live in its directive lines) and a
//     `glob.pattern` whose temp prefix becomes `path`. The host resolves these
//     paths itself (no MSYS mapping), so the rewrite belongs on that side.
//     A missing tool name or key fails safe: nothing is rewritten, which is
//     the pre-plugin status quo, and loud failures self-correct.

const PATH_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);

// ---- usage telemetry -------------------------------------------------------
// Counts how often the guarded tools actually run and which fixes fire, to
// measure the plugin's real hit rate. Same taxonomy as the pi sibling:
// denominator toolCalls[tool] bumps POST-gate (off-platform calls and
// foreign shells never inflate the base); numerator fixes[key] bumps ONLY in
// the branch where the value actually changed.
// KEY = fault mechanism; same mechanism's spellings merge, different
// mechanisms stay apart. The temp families split by mechanism on every
// surface (fixing /tmp's mount mapping does not fix $TEMP's expansion):
//   path.tempMount / path.tempVar / path.other
//   glob.tempMount / glob.tempVar (split only returns temp mechanisms)
//   patch.tempMount / patch.tempVar / patch.other
//   shell.workdir.tempMount / shell.workdir.tempVar / shell.workdir.other
//   shell.cmdFlag  (//c, //k, multi-flag, quoted name, basename path: one
//                   mechanism -- msys argv flag conversion is off)
//   shell.envPath  (drive value and /tmp value: one mechanism -- msys envp
//                   conversion is off)
// `.other` is a visible fallback: a future rewrite that changes a value
// without a classified mechanism is counted there, never silently merged.
// The old `path.temp`/`glob.tempPrefix`/`patch.tempLine`/`shell.workdir.temp`
// keys are left untouched in existing files (historical totals; new counts
// use the split keys). Storage: ctx.storage (the host's official
// plugin-scoped durable JSON -- lands in opencode.db's kv table; read it
// read-only with sqlite, never by guessing at the db schema from the plugin).
// Write timing lives in the functions below; every failure is swallowed:
// telemetry must never change what a tool call does.

const STATS_KEY = "stats";

// Explicit numerator names: a typo cannot silently create a new key.
// (The same mechanism on a different surface is a different key -- different
// code path; see the taxonomy comment above.)
type FixKey =
  | `path.${TempMechanism}`
  | "path.other"
  | `glob.${TempMechanism}`
  | `patch.${TempMechanism}`
  | "patch.other"
  | `shell.workdir.${TempMechanism}`
  | "shell.workdir.other"
  | "shell.cmdFlag"
  | "shell.envPath";

interface Stats {
  schema: 1;
  since: string;
  toolCalls: Record<string, number>;
  fixes: Record<string, number>;
}

let stats: Stats | null = null;
// What this process last read/merged-wrote: the in-memory numbers are
// "baseline + this process's increments", and only the increments are ours.
// flushStats re-reads the stored value first and re-applies just the delta,
// so two concurrent opencode servers sharing opencode.db no longer overwrite
// each other's whole snapshot with last-writer-wins (that window was the
// whole process lifetime; it is now the read..set window of a single flush --
// ctx.storage has no compare-and-set, the residue is documented in spec.md,
// and the counts stay advisory).
let statsBaseline: Stats | null = null;
let saveStats: (() => Promise<void>) | null = null;
let statsTimer: ReturnType<typeof setTimeout> | undefined;
let statsWrite: Promise<void> = Promise.resolve(); // serialization tail: sets must not land out of order

function adoptCounts(saved: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (saved && typeof saved === "object") {
    for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    }
  }
  return out;
}

export function statsSnapshot(): Stats | null {
  return stats && { ...stats, toolCalls: { ...stats.toolCalls }, fixes: { ...stats.fixes } };
}

// latest = what the store holds at flush time (possibly another process's
// write); current = our in-memory value (baseline + our increments). The
// result keeps the store's since and adds our per-key delta -- and it re-bases
// after every flush, so a repeated flush never double-counts. Misshapen store
// data falls back to our snapshot (adoptCounts coerces what is usable).
function mergeStats(latest: unknown, current: Stats, baseline: Stats): Stats {
  const ok =
    latest && typeof latest === "object" &&
    (latest as Partial<Stats>).schema === 1 &&
    typeof (latest as Partial<Stats>).since === "string";
  // always a fresh object: callers hand `current` to the baseline afterwards,
  // and a shared object would alias snapshots (measured zero deltas)
  if (!ok) return { schema: 1, since: current.since, toolCalls: { ...current.toolCalls }, fixes: { ...current.fixes } };
  const src = latest as Stats;
  const out: Stats = { schema: 1, since: src.since, toolCalls: {}, fixes: {} };
  for (const group of ["toolCalls", "fixes"] as const) {
    for (const [k, v] of Object.entries(adoptCounts(src[group]))) {
      const ours = current[group][k] ?? 0;
      const then = baseline[group][k] ?? 0;
      out[group][k] = v + Math.max(0, ours - then);
    }
    for (const [k, ours] of Object.entries(current[group])) {
      if (out[group][k] !== undefined) continue; // already merged above
      const then = baseline[group][k] ?? 0;
      out[group][k] = Math.max(0, ours - then);
    }
  }
  return out;
}

function flushStats(): Promise<void> {
  if (statsTimer) {
    clearTimeout(statsTimer);
    statsTimer = undefined;
  }
  const snap = statsSnapshot();
  if (snap && saveStats) {
    // chain onto the previous write: a debounced flush and an immediate
    // numerator flush can overlap, and two racing .set calls could otherwise
    // persist the older snapshot last (last-writer-wins with stale data)
    statsWrite = statsWrite
      .then(() => saveStats!())
      .catch(() => { /* telemetry stays silent */ });
  }
  return statsWrite;
}

function bumpTool(tool: string): void {
  if (!stats) return;
  stats.toolCalls[tool] = (stats.toolCalls[tool] ?? 0) + 1;
  if (!statsTimer) {
    statsTimer = setTimeout(flushStats, 5000); // batched: every call must not pay an IPC round trip
    statsTimer.unref?.(); // never keep a process alive just for telemetry
  }
}

function bumpFix(key: FixKey): void {
  if (!stats) return;
  stats.fixes[key] = (stats.fixes[key] ?? 0) + 1;
  flushStats(); // numerators are rare: persist at once, nothing is lost on unload
}

export default define({
  id: "env.guard",
  async setup(ctx) {
    if (process.platform !== "win32") return;
    if (!findBash()) return; // no MSYS bash: stay inert

    // load-and-merge: adopt whatever an earlier run already counted; if the
    // storage API itself misbehaves, counting continues in memory only
    try {
      const saved = (await ctx.storage.get(STATS_KEY)) as Partial<Stats> | undefined;
      stats =
        saved && typeof saved === "object" && saved.schema === 1 && typeof saved.since === "string"
          ? { schema: 1, since: saved.since, toolCalls: adoptCounts(saved.toolCalls), fixes: adoptCounts(saved.fixes) }
          : { schema: 1, since: new Date().toISOString(), toolCalls: {}, fixes: {} };
      // the loaded value is the first delta baseline; it must stay a COPY --
      // bumps mutate `stats` in place, and an aliased baseline zeroes every
      // delta (measured)
      statsBaseline = statsSnapshot();
      // Flush-time read-merge-write. Another process may have written since
      // our last set landed (two oc servers share the same db kv), so the
      // written value is the store's latest plus OUR delta: the local
      // counters at save time minus what the baseline already counted. The
      // baseline re-bases to that same snapshot at once, so
      //  - bumps that land while this save is awaiting belong to the next
      //    delta and are never re-delivered (the chained-save double count
      //    that the battery pins),
      //  - a repeated flush with unchanged counters writes exactly what the
      //    store holds (idempotent),
      //  - a snapshot held by an earlier chained save changes nothing -- the
      //    delta is taken from the CURRENT counters, not from the stale
      //    snapshot passed down the chain.
      // `stats` is kept LOCAL (loaded value + our bumps); only the written
      // value is global. Nothing aliases: statsSnapshot copies, mergeStats
      // always builds a fresh object, and the baseline is never mutated
      // (bumps change `stats` in place, aliased copies measured zero deltas).
      saveStats = async () => {
        const cur = statsSnapshot() ?? { schema: 1, since: new Date().toISOString(), toolCalls: {}, fixes: {} };
        const prevBase = statsBaseline ?? cur;
        statsBaseline = cur;
        let latest: unknown;
        try {
          latest = await ctx.storage.get(STATS_KEY);
        } catch { latest = undefined; }
        const merged = mergeStats(latest, cur, prevBase);
        return ctx.storage.set(STATS_KEY, merged);
      };
    } catch {
      stats = { schema: 1, since: new Date().toISOString(), toolCalls: {}, fixes: {} };
      statsBaseline = statsSnapshot();
      saveStats = null;
    }

    await ctx.tool.hook("execute.before", (event) => {
      const input = event.input as Record<string, unknown> | null;
      if (!input || typeof input !== "object") return;
      // a missing tool name fails safe: no rewrite (the contract a few lines
      // up), never a TypeError thrown from the hook itself
      const tool = typeof event.tool === "string" ? event.tool.toLowerCase() : "";
      if (tool === "patch") {
        bumpTool("patch");
        if (typeof input.patchText === "string") {
          const fix = rewritePatchTextFix(input.patchText);
          if (fix.text !== input.patchText) {
            input.patchText = fix.text;
            // one patch call may touch both mechanisms; bump each once
            if (fix.mechanisms.length) for (const m of fix.mechanisms) bumpFix(`patch.${m}`);
            else bumpFix("patch.other"); // a future non-temp rewrite stays visible
          }
        }
        return;
      }
      if (!PATH_TOOLS.has(tool)) return;
      bumpTool(tool);
      // glob: a temp-prefixed pattern carries its own directory
      if (tool === "glob" && typeof input.pattern === "string") {
        const hasPath = typeof input.path === "string" && input.path !== "";
        if (!hasPath) {
          const split = splitTempPrefix(input.pattern);
          if (split) {
            input.pattern = split.rest;
            input.path = split.dir;
            bumpFix(`glob.${split.mechanism}`);
          }
        }
      }
      if (typeof input.path !== "string") return;
      const fix = rewritePathFix(input.path);
      if (fix.value !== input.path) {
        input.path = fix.value;
        bumpFix(fix.mechanism ? `path.${fix.mechanism}` : "path.other");
      }
    });

    await ctx.shell.hook("create.before", (event) => {
      // String contract guards, the tool hook's typeof-gate counterpart: a
      // non-string shell cannot be verified (and a non-string command cannot
      // be scanned). No host non-string has ever been measured on v2.2.5 --
      // this is defensive parity, not a measured fault point -- but a
      // TypeError from this hook is the plugin breaking the spawn itself
      // (worse than any missed fix), and every branch outside the measured
      // contract chooses the pre-plugin status quo: no rewrite, no throw.
      if (typeof event.shell !== "string" || !isMsysShell(event.shell)) return;
      bumpTool("bash");
      // `workdir` reaches this hook unresolved (`/tmp`) and the host checks it
      // with Windows semantics afterwards ("Working directory does not exist:
      // C:\tmp" -- measured), so the same temp forms rewrite to the anchor
      // bash itself uses. Independent of the //c gate below.
      if (typeof event.cwd === "string") {
        const fix = rewritePathFix(event.cwd);
        if (fix.value !== event.cwd) {
          event.cwd = fix.value;
          bumpFix(fix.mechanism ? `shell.workdir.${fix.mechanism}` : "shell.workdir.other");
        }
      }
      if (!pathConvDisabled(event.shell)) return;
      if (typeof event.command !== "string") return;
      // convOff=true by construction here (the probe passed): with conversion
      // ON the native layer does both rewrites itself. Each rewrite reports
      // its own flag -- an envPath fix must not be mis-attributed to the
      // cmd-flag key by a rewritten !== input heuristic.
      const r = rewriteBashCommand(event.command, true);
      if (r.command !== event.command) event.command = r.command;
      if (r.cmdFlagFixed) bumpFix("shell.cmdFlag");
      if (r.envPathFixed) bumpFix("shell.envPath");
    });

    // unload: flush what the debounce still holds. Cleanup is typed
    // `() => Promise<void> | void` in @opencode/plugin -- returning the
    // promise lets the host await the final write instead of racing it.
    return () => flushStats();
  },
});
