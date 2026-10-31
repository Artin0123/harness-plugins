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
//
// Deliberately NOT fixed (native execution wins; let it fail where it fails):
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
//   - cmd + non-ASCII: cmd's Chinese output arrives GBK-mangled (measured;
//     the same run that printed the version also produced the mojibake);
//     there is no faithful rewrite (the pi sibling only warns) and the
//     mojibake itself is the visible, self-correcting signal.
//
// Scope discipline: NATIVE EXECUTION WINS -- agent errors and syntax that
// fails under its own native execution are left loud. Uncertainty resolves to
// "do not touch": an undetectable bash or a failed probe leaves the plugin
// inert (漏修大聲失敗可自癒；誤修是靜默破壞正確語法).

import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Plugin } from "@opencode/plugin";

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

// The caller decides WHEN to rewrite: the hook gates on a verified MSYS shell
// plus the path-conversion probe. The scanner itself always rewrites.
export function rewriteBashCommand(command: string): string {
  return scanBash(command);
}

function scanBash(command: string): string {
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
        const sub = scanBash(seg.slice(k + 2, close));
        s += "$(" + sub + ")";
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
        const sub = scanBash(seg.slice(k + 1, p));
        s += "`" + sub + "`";
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
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === ">" || ch === "<") {
      commitTok();
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
        }
        clearTok();
      } else {
        // a redirect target is not a command position and must not authorize
        // one either: "cmd > //out" -- the target is bash's own path syntax
        // and native "> //x" is a loud failure we leave alone
        cmdPosNext = false;
        clearTok();
      }
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
          continue;
        }
      }
      curTok += ch;
      out += ch;
      i++;
      continue;
    }
    curTok += ch;
    out += ch;
    i++;
  }
  return out;
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

export default Plugin.define({
  id: "env.guard",
  async setup(ctx) {
    if (process.platform !== "win32") return;
    if (!findBash()) return; // no MSYS bash: stay inert

    await ctx.tool.hook("execute.before", (event) => {
      const input = event.input as Record<string, unknown> | null;
      if (!input || typeof input !== "object") return;
      const tool = event.tool.toLowerCase();
      if (tool === "patch") {
        if (typeof input.patchText === "string") {
          const rewritten = rewritePatchText(input.patchText);
          if (rewritten !== input.patchText) input.patchText = rewritten;
        }
        return;
      }
      if (!PATH_TOOLS.has(tool)) return;
      // glob: a temp-prefixed pattern carries its own directory
      if (tool === "glob" && typeof input.pattern === "string") {
        const hasPath = typeof input.path === "string" && input.path !== "";
        if (!hasPath) {
          const split = splitTempPrefix(input.pattern);
          if (split) {
            input.pattern = split.rest;
            input.path = split.dir;
          }
        }
      }
      if (typeof input.path !== "string") return;
      const rewritten = rewritePath(input.path);
      if (rewritten !== input.path) input.path = rewritten;
    });

    await ctx.shell.hook("create.before", (event) => {
      if (!isMsysShell(event.shell)) return;
      // `workdir` reaches this hook unresolved (`/tmp`) and the host checks it
      // with Windows semantics afterwards ("Working directory does not exist:
      // C:\tmp" -- measured), so the same temp forms rewrite to the anchor
      // bash itself uses. Independent of the //c gate below.
      if (typeof event.cwd === "string") {
        const cwd = rewritePath(event.cwd);
        if (cwd !== event.cwd) event.cwd = cwd;
      }
      if (!pathConvDisabled(event.shell)) return;
      const rewritten = rewriteBashCommand(event.command);
      if (rewritten !== event.command) event.command = rewritten;
    });
  },
});
