// env-guard -- protects OpenCode's Windows shell and file tools from this
// machine's measured environment failures. Same judgement framework as the
// pi-extensions and cmdc-mods siblings in Artin0123/harness-plugins; every fix
// below is anchored to a failure MEASURED on this machine (Git for Windows
// 2.56.0 / MINGW64, opencode v2.2.5 -- the old read '/tmp/x' failure was
// first seen on v2.2.1):
//
//   1. every path this host resolves WITHOUT MSYS mapping: file-tool `path`,
//      the shell tool's `workdir`, a temp prefix inside a `glob` pattern, and
//      the paths in `patch` directives (all measured). read '/tmp/x' looks at
//      C:\tmp (host normalization: workdir '/tmp' fails with "Working
//      directory does not exist: C:\tmp"), write '$TEMP/x' (or '${TEMP}/x')
//      creates a literal '$TEMP' folder under the project, glob
//      '${TEMP}/*.txt' silently finds nothing, and patch
//      '*** Add File: ${TEMP}/x' makes a literal folder.
//      -> /tmp, $TEMP/$TMP/$TMPDIR (bare and ${...}), %TEMP%/%TMP%
//      (any case, either separator) rewrite to the directory the detected bash
//      itself reports for /tmp (cygpath -w /tmp): that is the mapping bash
//      uses for its own '/tmp', so both sides of a command agree on it.
//      bash-side /tmp is untouched (MSYS mounts it correctly). os.tmpdir() is
//      NOT the authority here: on this machine MSYS already converts TEMP to a
//      Windows path for native children (measured), yet the shell tool's bash
//      is what defines '/tmp'.
//   2. this machine's BASH_ENV (.bashrc, which `bash -c` sources) sets
//      MSYS_NO_PATHCONV=1, so the MSYS-doubled flag spelling `cmd //c` reaches
//      cmd.exe literally and starts an INTERACTIVE cmd: measured with stdin
//      closed -- exit 0, and stdout is the banner + copyright + prompt
//      ("Microsoft Windows [Version ...]" then "(c) Microsoft Corporation..."
//      then "C:\...>") instead of `ver`'s single line. The banner's first line
//      mimics `ver` closely enough that a model can read it as the answer,
//      which is why this is a silent failure. -> rewrite //flags to /flags on
//      command-position cmd only, including nested $( ) / backticks / double
//      quotes, shell keywords ({ } if/then/do ...) and the tight `cmd//c`
//      form; data positions are untouched (`echo cmd //c`, redirect targets
//      (`cmd > //out` -- native "> //x" is a loud failure), heredoc bodies
//      (exact terminator match, <<\EOF and non-word delimiters included) and
//      the word after a closed `$( )`/backtick (`echo $(pwd) cmd //c ver`)).
//      The rewrite is GATED on a probe of that environment (bash -c 'printf
//      %s "${MSYS_NO_PATHCONV+x}"', which sources .bashrc through BASH_ENV;
//      the variable is presence-based in the MSYS runtime -- "0" and "" also
//      disable conversion, measured): with path conversion ON, `//c` is the
//      spelling that works and rewriting it
//      would BE the side effect; a failed or inconclusive probe leaves
//      everything alone (uncertainty never enables side effects; `/c` works in
//      both configurations).
//   3. bash prefix-assignment POSIX path values (`A=/c/x node ...`): measured
//      native git-bash converts the VALUE at the msys->native envp boundary
//      (name-agnostic value-grammar conversion: FOO and XDG_CACHE_HOME are
//      treated alike; /c/foo -> C:/foo, /tmp -> its mount anchor, forward
//      slashes), and this machine's .bashrc (sourced through BASH_ENV) disables
//      that layer with MSYS_NO_PATHCONV like `//c`, so the raw value reaches
//      the native child and is resolved as a drive-relative path -- Node
//      writes to C:\c\foo with exit 0 (measured silent). The rewrite
//      reproduces that layer fair: only command-position assignments followed
//      by a real command word (the value then provably enters that command's
//      environment); the two verifiable anchors /c and /tmp (deliberately
//      conservative -- single-letter drive roots and colon-list values
//      convert natively on this machine too and stay misses); staged and
//      applied right-to-left via spans, discarded at every standalone
//      boundary (separator, background &, newline, redirect, heredoc, word
//      head `#`, EOF), kept through a closer restoring the command position
//      so the tight dynamic-tail form composes (VAR=/c/x$(pwd) node).
//      Scanner details and the native fact base live in the scanBash section
//      below and in docs/spec.md (掃描器要點).
//
// NATIVE failures (the tool's return equals what native would return, so the
// agent sees the real cause and self-corrects) stay untouched -- rewriting
// them IS the side effect:
//   - C:\\tmp in file tools: a legal Windows path, the native write simply
//     succeeds (measured). The model choosing C:\\tmp is not environment
//     breakage.
//   - MSYS drive-letter paths (/c/Users/...): OpenCode's tool layer maps them
//     itself (measured on v2.2.1 for read; re-measured on v2.2.5 for shell
//     workdir '/c/Users/...', which ran in the right directory). A rewrite
//     here would be duplicate protection, pure side effect.
//   - `nul` redirect targets: re-measured today -- bash writes a real 3-byte
//     `nul` file even for a bare `> nul` in a fresh process (differs from the
//     pi sibling's machine) -- but this is bash-native behaviour, not
//     something this environment's tooling inflicts, so it stays untouched;
//     `rm ./nul` removes it.
//   - cmd + non-ASCII: cmd's Chinese output arrives GBK-mangled, which is
//     exactly what a native terminal would print (parity holds) -- the
//     mojibake is the visible, self-correcting signal and there is no
//     faithful rewrite.
//   - `cmd //?`, `cmd ///c`, `cmd //server/share`: WAS-error without
//     conversion as well -- the model's own syntax error, native.
//
// MISSED FIXES (漏修 ledger -- failures the environment's conversion layer
// inflicts, so the tool's return does NOT equal the native return: a loud
// failure does NOT exempt these, it just self-corrects where the message is
// still faithful; they stay unfixed only where every static rewrite is an
// open-set guess and the better-to-miss-than-mis-fix rule binds):
//   - //flags for other native /-switch programs (taskkill //IM, sc, net,
//     reg, robocopy //mir, findstr //n...): same fault as //c, but the
//     failure is loud and the rewrite needs an open list of which programs
//     take /-flags (open set + guessing).
//   - cmd behind external wrappers (timeout 5 cmd //c ..., xargs..., nice...),
//     quoted "cmd" //c, escaped \\cmd //c: same fault; wrapper argument
//     structures are an open set (timeout/nice/xargs), the quoted and
//     escaped spellings are not the builder's habit (measured: zero organic
//     occurrences in this machine's command log).
//   - POSIX path arguments of native programs (`git -F /tmp/x`, `python
//     /tmp/x.py`): conversion is what makes them work natively; here they
//     fail loudly. Deciding which argument is a path is per-program (open
//     set) and rewriting every /... token would corrupt string/regex data.
//   - envp residual boundaries (see the scanner section): quoted-leading and
//     list/backslash values, root-relative and single-letter drive roots,
//     tight VAR=/c$(...), redirect-interleaved prefixes, standalone "node",
//     function bodies and msys internals that read the value back -- native
//     converts these (or reads the value it kept); the scanner cannot see an
//     unquoted full value or a program's argument semantics without the
//     same open-set guessing.
//
// Scope discipline: NATIVE EXECUTION WINS -- agent errors and syntax that
// fails under its own native execution are left loud. Uncertainty resolves to
// "do not touch": an undetectable bash or a failed probe leaves the plugin
// inert (寧可漏修，不可誤修：誤修是靜默破壞正確語法；漏修是環境層未修的故障臺,
// 大聲只是失敗形態,不是不修的豁免).

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

// In s, index of the ")" matching the "$(" in front of `from`; -1 if absent.
// Understands bash nesting: quotes reopen context, but $( ) and backticks
// still execute inside double quotes; single quotes are fully literal.
function matchParen(s: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") {
      let p = i + 1;
      while (p < s.length && s[p] !== "'") p++;
      i = p + 1;
      continue;
    }
    if (c === '"') {
      let p = i + 1;
      while (p < s.length && s[p] !== '"') {
        if (s[p] === "\\") { p += 2; continue; }
        if (s[p] === "$" && s[p + 1] === "(") {
          const cl = matchParen(s, p + 2);
          if (cl === -1) return -1;
          p = cl + 1;
          continue;
        }
        if (s[p] === "`") {
          let q = p + 1;
          while (q < s.length && s[q] !== "`") {
            if (s[q] === "\\") q++;
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

// The temp forms a host-side path resolver never expands: /tmp and the
// bash/cmd variables. One list, used by the path rewrite and the glob prefix
// split so the two can never drift apart.
const TEMP_FORM = /^(?:\/tmp|\$(?:tmpdir|temp|tmp)|\$\{(?:tmpdir|temp|tmp)\}|%(?:temp|tmp)%)/i;

// File-tool path rewrite: the temp-dir forms only. Everything else --
// relative paths, other drives, drive-letter MSYS paths (handled natively by
// OpenCode's tool layer) -- passes through untouched. Windows-only: the
// failure point is this host's Windows path resolution; on other platforms
// /tmp and $TEMP are native semantics and rewriting them would BE the side
// effect. No measured anchor -> inert (no guessed layout).
export function rewritePath(p: string): string {
  // checked at call time (not a captured const) so the battery can pin the
  // non-Windows behaviour with a platform override
  if (process.platform !== "win32") return p;
  const head = TEMP_FORM.exec(p);
  if (!head) return p;
  const rest = p.slice(head[0].length);
  // $TEMPFILE/x, /tmpfoo/x and friends are not the temp dir
  if (rest !== "" && !/^[\\/]/.test(rest)) return p;
  const realTemp = realTempDir();
  if (!realTemp) return p;
  const tail = rest.replace(/\//g, "\\").replace(/\\+$/, "");
  return tail ? realTemp + tail : realTemp;
}

// ---- patch text: same host-side paths, written as patch directives ---------
// `patch` takes no path field: paths live inside `patchText` as `*** Add File:`,
// `*** Update File:`, `*** Delete File:` and `*** Move to:` lines. The host
// resolves those with the same Windows semantics (measured: an added
// "${TEMP}/x" landed in a literal "${TEMP}" directory under the project), so
// the same temp forms rewrite -- and only on directive lines, so patch content
// (whose lines start with ' ', '+' or '-') is never touched.

const PATCH_PATH_LINE = /^(\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: )([^\r\n]+?)(\r?)$/;

export function rewritePatchText(text: string): string {
  if (!text.includes("*** ")) return text;
  return text
    .split("\n")
    .map((line) => {
      const m = PATCH_PATH_LINE.exec(line);
      if (!m) return line;
      const rewritten = rewritePath(m[2]!);
      return rewritten === m[2] ? line : m[1]! + rewritten + m[3]!;
    })
    .join("\n");
}

// A glob pattern may carry the directory itself ("${TEMP}/*.txt"). glob has no
// implicit path handling here: the literal prefix matched nothing (measured,
// 0 results -- a silent false negative), so the leading temp form moves into
// `path` and the rest stays the pattern. Only used when the call has no path,
// so a call that works today is never reshaped.
export function splitTempPrefix(pattern: string): { dir: string; rest: string } | null {
  if (process.platform !== "win32") return null;
  const head = TEMP_FORM.exec(pattern);
  if (!head) return null;
  const rest = pattern.slice(head[0].length);
  if (!/^[\\/].+/.test(rest)) return null;
  const realTemp = realTempDir();
  if (!realTemp) return null; // no anchor: leave the pattern alone
  return { dir: realTemp, rest: rest.slice(1).replace(/\\/g, "/") };
}

// ---- shell command scan: cmd doubled flags, position-aware ----------------

// Two rewrites, one position-aware scan:
//   cmdFlag: `cmd //c|//k` -> /c|/k (the interactive-cmd failure above);
//     fires only when the caller says the conversion layer is OFF (the hook
//     probes it; with conversion ON `//c` is the spelling that works, so
//     rewriting it would BE the side effect -- scanner trusts the caller).
//   envPath: a command-position assignment prefix with a POSIX absolute path
//     value (`A=/c/x node …`) gets the native envp conversion value. Measured
//     on this machine (Git for Windows 2.56.0): with conversion ON, the
//     msys->native exec boundary converts the VALUE grammar, name-agnostic
//     (`A=/c/x node` -> node receives C:/x; `bash -c 'echo $A'` stays /c/x;
//     `A=/c$(echo foo)` -> <msys-root>/cfoo; tight `A=/c/x$(pwd) node` >=
//     prefix + verbatim suffix = native conversion of the joined value). This
//     machine's .bashrc sets MSYS_NO_PATHCONV through BASH_ENV, so that layer
//     is off here and the value arrives raw, resolved by Node as a
//     drive-relative path (path.resolve('/c/x') -> C:\c\x, exit 0 -- silent).
//     The rewrite reproduces ONLY that layer's two verifiable anchors
//     (deliberate conservatism, NOT a claim that the native layer converts
//     nothing else -- colon-list values convert natively with their own
//     rule set, and are left as misses): the drive-letter form is
//     LETTER-GENERIC (measured: /m /b /q /x /y /z all resolve through the
//     msys mount table and convert natively -> M:/x etc.) and the /tmp
//     anchor:
//     `A=/<drive>[...]` -> X:<...> (case-insensitive in, capital drive,
//     forward slashes, native-identical), `A=/tmp[...]` -> the realTempDir
//     anchor.
//     Staged per assignment token (span in the output), applied only when a
//     real command word of the same simple command lands -- the value is then
//     KNOWN to cross the exec boundary; standalone assignments are shell
//     variables whose POSIX value is bash-side semantics (rewriting them IS
//     the mis-fix). Drop points (each pins one discard path): separators,
//     `&` background, newline, redirect (incl. fd targets), heredoc, `#` as
//     the word head, EOF. The one keep: a closed `$( )` restoring command
//     position -- `VAR=/c/x$(pwd) node` closes the value with the following
//     command word.
// Values deliberately not rewritten (residual misses -- the native layer
//   converts them, the scanner cannot see an unquoted full value, and the
//   direction is loud-or-native-safe): quoted-leading values, list / backslash
//   values, root-relative values (/usr... -> MSYS install root, mount
//   dependent), tight forms whose static prefix
//   stops at the drive letter (VAR=/c$(...)), the standalone quoted word
//   ("node"), and redirect-interleaved prefixes (A=/c/x > log node).
// Mixed boundary, applied-bias kept (documented residual): functions and other
//   msys programs are an open set -- when their dynamic scope spawns native,
//   native converts just like this rewrite; when the value is only read
//   back, native does not convert and the rewrite diverges (rare, silent).
//
// Returns flags separately (telemetry): an envPath rewrite must not be
// counted under a synthetic "rewritten !== input" heuristic as a cmd-flag fix.
export interface BashScanResult {
  command: string;
  cmdFlagFixed: boolean;
  envPathFixed: boolean;
}

export function rewriteBashCommand(command: string, convOff = true): BashScanResult {
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

function scanBash(command: string, convOff = true): BashScanResult {
  // group 1: the <<- dash; group 2: the backslash of <<\EOF (literal body);
  // the delimiter is a bash WORD, quoted (any content, quotes stripped --
  // the terminator line compares bare, like bash) or unquoted starting with
  // a letter and free of shell metacharacters; the letter gate keeps
  // $((1<<2)) arithmetic out of the heredoc path
  const heredoc = /<<(-?)[ \t]*(\\?)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([A-Za-z_][^\s"'><;&|()\\`]*))/y; // sticky, anchored at lastIndex
  const cmdFlag = /\/\/([A-Za-z]+)(?![\w.-])/iy; // cmd flags are alphabetic; /v:on keeps its colon tail
  let out = "";
  let i = 0;
  const n = command.length;
  let pendingDelim: string | null = null;
  let pendingDash = false; // <<- (strips leading TABS from terminator lines)
  let inHeader = false;
  // token tracking: only rewrite flags of a cmd in COMMAND position, never
  // literal data (`echo cmd //c` stays verbatim)
  let curTok = "";
  let prevTok = "";
  let prevTokCmdPos = false;
  let cmdPosNext = true;
  let cmdFlagZone = false; // after cmd, /flags keep the zone alive (cmd //q //c)
  let cmdFlagFixed = false;
  let envPathFixed = false;
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
  // "subst" = $(, "func" = foo(, "case" = a "( pattern" wrapper inside a case
  // pattern region, "group" = everything else; a ")" restores accordingly
  // (func/case always keep the position)
  const parenStack: { kind: string; pos: boolean }[] = [];
  // case tracking: "case" (command position) arms it, the case's "in" starts
  // the PATTERN region -- its ")" terminates the pattern and opens the body
  // -- ";;" returns to the pattern region and "esac" ends it. The region
  // decides what a ")" closes: a pattern ")" has no matching "(" (popping on
  // it steals the enclosing substitution's stack entry), while a $( ) in the
  // BODY is an ordinary paren and must pop normally.
  let caseRegion: "none" | "pattern" | "body" = "none";
  let casePending = false; // saw "case", waiting for the case's "in"

  // A cmd token is recognised by basename, so an explicit path
  // (C:\Windows\System32\cmd.exe) is the same command as `cmd`. Quoted
  // spellings ("cmd") still fall through -- no rewrite, the pre-plugin
  // behaviour (documented as a known miss).
  const isCmdTok = (t: string) => {
    const base = t.split(/[\\/]/).pop()!.toLowerCase();
    return base === "cmd" || base === "cmd.exe";
  };

  // Shell keywords never end a command position (if/then/do/{ ... }), so a
  // cmd after them is still the command being run. Only matters when the
  // token is literally cmd, so a wrong guess cannot rewrite anything else.
  const SHELL_KEYWORDS = new Set([
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
    "case", "esac", "in", "select", "function", "time", "exec", "command",
    "builtin", "env", "!", "{", "}",
  ]);

  // a close or separator starts a fresh token context: tokens from INSIDE a
  // substitution must not authorize a rewrite outside it ("echo $(cmd) //x"
  // -- //x is echo's argument, not a cmd flag)
  const clearTok = () => {
    prevTok = "";
    prevTokCmdPos = false;
    cmdFlagZone = false;
  };

  const commitTok = () => {
    if (!curTok) return;
    prevTokCmdPos = cmdPosNext;
    if (cmdPosNext) {
      // FOO=bar env prefixes and shell keywords do not end the command position
      cmdPosNext =
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(curTok) || SHELL_KEYWORDS.has(curTok.toLowerCase());
    }
    // case-region tracking (see the declaration above for the grammar)
    const low = curTok.toLowerCase();
    if (low === "case" && prevTokCmdPos) casePending = true;
    else if (low === "in" && casePending) {
      caseRegion = "pattern";
      casePending = false;
    } else if (low === "esac") {
      caseRegion = "none";
      casePending = false;
    }
    if (cmdFlagZone && !curTok.startsWith("/")) cmdFlagZone = false;
    if (prevTokCmdPos && isCmdTok(curTok)) cmdFlagZone = true;
    // prefix-assignment staging / apply (envp): the assignment token (whole
    // word, unquoted) in command position is staged; a later real command
    // word (non-assignment incl. empty-value, non-keyword, non-builtin,
    // non-pure-digit) landing in the SAME simple command means the value will
    // enter that command's environment -- apply. Empty-value assignments
    // neither stage (nothing convertible) nor trigger apply (see
    // envpTrigger). prevTokCmdPos here is still THIS token's position.
    if (prevTokCmdPos) {
      const em = ASSIGN_PREFIX.test(curTok)
        ? /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(curTok)
        : null;
      if (em) {
        const conv = convertEnvPath(em[2]!);
        if (conv) pendingEnv.push({ start: out.length - curTok.length, end: out.length, rep: em[1]! + "=" + conv });
      } else if (envpTrigger(curTok)) {
        applyPendingEnv();
      }
    }
    prevTok = curTok;
    curTok = "";
  };

  // $( ) and `...` execute inside double quotes too: recurse into them.
  const scanDq = (seg: string): string => {
    let s = "";
    let k = 0;
    const m2 = seg.length;
    while (k < m2) {
      const c = seg[k];
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
          if (seg[p] === "\\") p++;
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
    // heredoc bodies are data: copy verbatim; the delimiter line ends the
    // body. (Unquoted bodies still undergo $( )/backtick expansion in bash;
    // those inner commands are deliberately NOT rewritten -- a loud miss
    // beats scanning inside body data.)
    if (pendingDelim !== null && !inHeader) {
      let lineEnd = command.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = n;
      // bash matches the terminator line EXACTLY (<<- strips leading tabs
      // only, nothing else) -- a trim() here would end the body early and
      // rewrite its lines ("EOF " / "  EOF" are BODY) -- except that ONE
      // trailing \r is ignored: measured, both a full-CRLF text and a clean
      // delimiter followed by an "EOF\r" line terminate the body here.
      const raw = command.slice(i, lineEnd).replace(/\r$/, "");
      if ((pendingDash ? raw.replace(/^\t+/, "") : raw) === pendingDelim) {
        out += command.slice(i, Math.min(lineEnd + 1, n));
        i = lineEnd + 1;
        pendingDelim = null;
        pendingDash = false;
        curTok = "";
        clearTok();
        cmdPosNext = true; // a fresh command line follows
        continue;
      }
      out += command.slice(i, Math.min(lineEnd + 1, n));
      i = lineEnd + 1;
      continue;
    }
    const ch = command[i];
    if (ch === "\n" && pendingDelim !== null && inHeader) {
      out += "\n";
      i++;
      inHeader = false;
      curTok = "";
      clearTok();
      continue;
    }
    if (ch === "\\") {
      const seg = command.slice(i, i + 2);
      out += seg;
      curTok += seg; // escaped chars belong to the token (\> is no operator)
      i += 2;
      continue;
    }
    if (ch === "'") {
      commitTok();
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        const seg = command.slice(i);
          out += seg;
        break;
      }
      const seg = command.slice(i, end + 1);
      out += seg;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      commitTok();
      // closing quote hunt: $() and backticks reopen quote context
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") { j += 2; continue; }
        if (command[j] === "$" && command[j + 1] === "(") {
          const close = matchParen(command, j + 2);
          if (close === -1) { j = n; break; }
          j = close + 1;
          continue;
        }
        if (command[j] === "`") {
          let p = j + 1;
          while (p < n && command[p] !== "`") {
            if (command[p] === "\\") p++;
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
        break;
      }
      const seg = command.slice(i, j + 1);
      out += scanDq(seg);
      i = j + 1;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      commitTok();
      heredoc.lastIndex = i;
      const m = heredoc.exec(command);
      if (m) {
        pendingDelim = m[3] ?? m[4] ?? m[5];
        pendingDash = m[1] === "-";
        inHeader = true;
        pendingEnv.length = 0; // heredoc redirect = no command word after the assignment (standalone) -> discard
        out += m[0];
        i += m[0].length;
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
      if (ch === ";" && command[i + 1] === ";" && caseRegion === "body") {
        caseRegion = "pattern"; // ";;" ends the body: the next pattern follows
      }
      if (ch === "(") {
        // classify the paren and remember the OUTER command position at open
        // time: $( opens a substitution, foo( is a function definition
        // ("{ cmd" follows), a "( pattern" wrapper inside a case PATTERN
        // region is closed by the pattern's ")", anything else is a group /
        // subshell opener. The saved position decides what the closing ")"
        // restores: "count=$(...) cmd" opened from an assignment prefix
        // (position alive -- bash runs cmd), while "echo $(...) cmd" opened
        // from an argument (cmd is data).
        const kind =
          caseRegion === "pattern"
            ? "case"
            : command[i - 1] === "$"
              ? "subst"
              : /[A-Za-z0-9_]/.test(command[i - 1] ?? "")
                ? "func"
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
          // command position.
          if (parenStack.length && parenStack[parenStack.length - 1]!.kind === "case") {
            parenStack.pop();
          }
          cmdPosNext = true;
          caseRegion = "body";
        } else {
          // an ordinary paren close -- also inside a case BODY: the ")" of
          // "case x in a) echo $(pwd) cmd" must pop, leaving cmd as echo's
          // argument. Restore what the matching "(" saved: "count=$(...)
          // cmd" (assignment prefix -- bash runs cmd) keeps the position,
          // "echo $(...) cmd" ends it; "foo()" and a stray ")" keep it.
          const fr = parenStack.pop();
          cmdPosNext =
            fr === undefined || fr.kind === "func" || fr.kind === "case"
              ? true
              : fr.pos;
          restoreTrue = fr !== undefined && (fr.kind === "func" || (fr.kind === "subst" && fr.pos === true));
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
    // cmd doubled flags: only in command position relative to cmd (incl. tight cmd//c)
    if (ch === "/" && command[i + 1] === "/") {
      const atCmd =
        curTok === ""
          ? (prevTokCmdPos && isCmdTok(prevTok)) || (cmdFlagZone && prevTok.startsWith("/"))
          : cmdPosNext && isCmdTok(curTok);
      if (atCmd) {
        cmdFlag.lastIndex = i;
        const m = cmdFlag.exec(command);
        if (m) {
          // tight cmd//c: cmd was already emitted, insert the separator space
          out += (curTok === "" ? "" : " ") + "/" + m[1];
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
    // a `#` at the head of a word is a comment: the staged assignment ends
    // here as a bash-side standalone (dropped BEFORE this `#` commits -- at
    // word head in command position it would otherwise count as the command
    // word and wrongly apply). `#` inside a word (a#b) is data, untouched.
    if (ch === "#" && curTok === "") pendingEnv.length = 0;
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
// Two hooks, each on the boundary where the environment breaks the command:
//   ctx.shell.hook("create.before") -> event.command (the exact string the host
//     hands to the shell) and event.cwd (the shell's `workdir`, still
//     unresolved here). `shell` names the executable it will spawn, so both
//     rewrites are gated on that shell being a verified MSYS bash; the //c
//     rewrite additionally needs the MSYS_NO_PATHCONV probe. A cmd/pwsh/WSL
//     shell or an unknown value leaves everything untouched.
//   ctx.tool.hook("execute.before") -> event.input for the file tools: `path`,
//     plus `patch.patchText` (paths live in its directive lines) and a
//     `glob.pattern` whose temp prefix becomes `path`. The host resolves these
//     paths itself (no MSYS mapping), so the rewrite belongs on that side;
//     `input` is mutable in this hook and the mutation reaches execution. A
//     missing tool name or key fails safe: nothing is rewritten, which is the
//     pre-plugin status quo, and loud failures self-correct.
// Measured on v2.2.5: both mutations land on the spawned command line.

const PATH_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);

// ---- usage telemetry -------------------------------------------------------
// Counts how often the guarded tools actually run and which fixes fire, to
// measure the plugin's real hit rate. Same taxonomy as the pi sibling:
//   denominator  toolCalls[tool] -- one bump per guarded-tool call, POST-gate
//     (the hooks only exist after the win32 + findBash gates pass, and the
//     bash bump sits behind the MSYS shell check, so off-platform calls and
//     foreign shells never inflate the base)
//   numerator    fixes[key] -- one bump per actual rewrite, keyed by fault
//     point; same-nature variants share one key (/tmp, $TEMP, ${TEMP},
//     %TEMP% all count as "path.temp"; //c, //q //c and tight cmd//c all
//     count as "shell.cmdFlag"; A=/c/... and A=/tmp/... prefixes both count
//     as "shell.envPath"), different kinds stay separate.
//     OC-only keys: glob.tempPrefix, patch.tempLine, shell.workdir.temp.
// Storage: ctx.storage (the host's official plugin-scoped durable JSON --
// it lands in opencode.db's kv table; read it read-only with sqlite, never
// by guessing at the db schema from the plugin). Numerators persist at once
// (they are rare); denominators batch on a 5s debounce, and the setup
// cleanup flushes what is pending. Every failure is swallowed: telemetry
// must never change what a tool call does.

const STATS_KEY = "stats";

interface Stats {
  schema: 1;
  since: string;
  toolCalls: Record<string, number>;
  fixes: Record<string, number>;
}

let stats: Stats | null = null;
let saveStats: ((s: Stats) => Promise<void>) | null = null;
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
      .then(() => saveStats!(snap))
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

function bumpFix(key: string): void {
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
      saveStats = (s) => ctx.storage.set(STATS_KEY, s);
    } catch {
      stats = { schema: 1, since: new Date().toISOString(), toolCalls: {}, fixes: {} };
      saveStats = null;
    }

    await ctx.tool.hook("execute.before", (event) => {
      const input = event.input as Record<string, unknown> | null;
      if (!input || typeof input !== "object") return;
      const tool = event.tool.toLowerCase();
      if (tool === "patch") {
        bumpTool("patch");
        if (typeof input.patchText === "string") {
          const rewritten = rewritePatchText(input.patchText);
          if (rewritten !== input.patchText) {
            input.patchText = rewritten;
            bumpFix("patch.tempLine");
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
            bumpFix("glob.tempPrefix");
          }
        }
      }
      if (typeof input.path !== "string") return;
      const rewritten = rewritePath(input.path);
      if (rewritten !== input.path) {
        input.path = rewritten;
        bumpFix("path.temp");
      }
    });

    await ctx.shell.hook("create.before", (event) => {
      if (!isMsysShell(event.shell)) return;
      bumpTool("bash");
      // `workdir` reaches this hook unresolved (`/tmp`) and the host checks it
      // with Windows semantics afterwards ("Working directory does not exist:
      // C:\tmp" -- measured), so the same temp forms rewrite to the anchor
      // bash itself uses. Independent of the //c gate below.
      if (typeof event.cwd === "string") {
        const cwd = rewritePath(event.cwd);
        if (cwd !== event.cwd) {
          event.cwd = cwd;
          bumpFix("shell.workdir.temp");
        }
      }
      if (!pathConvDisabled(event.shell)) return;
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
