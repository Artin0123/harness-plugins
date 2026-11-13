// env-guard -- protects OpenCode's Windows shell and file tools from this
// machine's measured environment failures. Same judgement framework as the
// pi-agent and cmdc-mods siblings in the harness-setup repo; every fix
// is anchored to a failure MEASURED on this machine (Git for Windows 2.56.0 /
// MINGW64, opencode v2.2.5). User view & install: README.md; the design
// record (why the input-side bash lexer was removed and replaced by
// output-side detection): docs/oc-env-guard-redesign.md; the deliberate-
// no-fix / missed-fix ledgers: docs/spec.md. Comments here keep only what
// reading and safely modifying the code requires.
//
// Priority: NATIVE EXECUTION WINS -- syntax that fails under its own native
// execution stays loud (the tool's return equals what native would return;
// the agent sees the real cause and self-corrects); only failures inflicted
// by this environment's conversion/tooling layer (return != native, loud OR
// silent) are fix targets; uncertainty never enables a rewrite -- a failed
// probe leaves the feature inert (寧可漏修，不可誤修).
//
// Redesign 2026-11-05: the input-side bash scanner (600-line position-aware
// lexer that rewrote `cmd //c` and command-position envp values) is GONE --
// its rewrite position was an open set (bash grammar), which made the
// missed-fix/misfix trade structurally unsolvable (4 days, 6 misfix commits).
// The remaining fixes are one class:
//   CLOSED-SET INPUT (rewrite position is sealed by the host's own API):
//   1. paths the host resolves WITHOUT MSYS mapping -- file-tool `path`,
//      `shell.cwd` (the spawn workdir), a `glob` pattern temp prefix, the
//      directive lines of `patch`: /tmp, $TEMP/$TMP/$TMPDIR (bare and
//      ${...}), %TEMP%/%TMP% rewrite to the anchor the detected bash itself
//      reports for /tmp (cygpath -w /tmp). The `path` field is always a path
//      and never anything else, so these rewrites cannot break syntax.
//
// Not fixed (inventory against regression; per-item evidence in spec.md):
//   NATIVE (return == native): C:\tmp in file tools; MSYS drive-letter paths
//     (the host's tool layer maps them itself); `nul` redirect targets;
//     natively-broken `cmd //?`/`///c`/`//server/share` (model errors); the
//     tight spelling `cmd//c` (bash takes it as a program name, loud 127).
//   MISSED (return != native, but every static rewrite is an open-set
//     guess): //flags of other /-switch programs (robocopy hangs), cmd behind
//     wrappers, POSIX path arguments of native programs, envp residual value
//     shapes. The input string is never rewritten for any of these.
//   cmd's GBK mojibake is its own case: the repair lives in the host's
//     decode layer -- out of scope; the mojibake is the visible signal.

import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// `define` is identity -- `export function define(plugin) { return plugin }`, in the
// installed 2.2.5 tarball (dist/effect/plugin.js). Declaring it here keeps the plugin
// dependency-free: importing @opencode/plugin instead makes npm auto-install the peer
// tree (273 packages / 168 MB per install, measured).
const define = <T>(plugin: T): T => plugin;

// ---- bash detection (scan + verify identity; no install paths hardcoded) --
// C:\Windows\System32\bash.exe is the WSL launcher and always sits on PATH, so
// every candidate must answer `uname -s` with an MSYS/MINGW prefix (WSL
// answers "Linux"). Candidates: PATH scan (skipping System32), the install
// root derived from a PATH git.exe (scoop shims name the real install in the
// sibling git.shim), the Git for Windows registry keys, then env-derived
// program roots. Measured on this machine: oc's spawn (v2.2.5) resolves to
// <git>\usr\bin\bash.exe and findBash() returns exactly that. Nothing found
// -> null -> the plugin installs nothing (inert).
let bashCache: string | null | undefined;

const MSYS_UNAME = /^(MINGW|MSYS)/;

const GIT_REG_KEYS = [
  "HKLM\\SOFTWARE\\GitForWindows",
  "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
  "HKCU\\SOFTWARE\\GitForWindows",
];

const msysVerified = new Map<string, boolean>();

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

// ---- shell identity --------------------------------------------------------
// The shell hook reports the executable the host is about to spawn. Only a
// shell that verifiably answers `uname -s` with an MSYS prefix is ours; a
// config value of bash/sh is resolved through the same detection as above,
// anything else (cmd, powershell, pwsh, wsl.exe) is left alone. Results are
// cached per executable so a hook never re-probes an already-known shell.

function shellCandidate(shell: string): string | null {
  if (!shell) return null;
  if (/[\\/]/.test(shell)) return existsSync(shell) ? shell : null;
  const base = shell.toLowerCase().replace(/\.exe$/, "");
  if (base !== "bash" && base !== "sh") return null;
  return findBash();
}

export function isMsysShell(shell: string): boolean {
  const cand = shellCandidate(shell);
  return cand !== null && verifyMsysBash(cand);
}

// ---- temp forms (closed set): one list feeds every surface ----------------
// The temp forms a host-side path resolver never expands: /tmp (MSYS mount)
// and the bash/cmd variables. ONE list feeds the path rewrite, the glob prefix
// split, and the patch directives -- the same call returns the mechanism used
// for the stats key, so "value changed" and "counted" can never disagree.
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
// is never touched. A single patch call may contain both mechanisms.

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

// ---- usage telemetry -------------------------------------------------------
// Counts how often the guarded tools actually run and which fixes fire.
// KEY = surface x fault mechanism; same mechanism's spellings merge.
//   path.tempMount / path.tempVar / path.other
//   glob.tempMount / glob.tempVar
//   patch.tempMount / patch.tempVar / patch.other
//   shell.workdir.tempMount / shell.workdir.tempVar / shell.workdir.other
// Historical keys (`shell.cmdFlag`, `shell.envPath`, `path.temp`, ...) are
// never renamed: adoptCounts keeps whatever an existing store holds.
// Storage: ctx.storage (the host's official plugin-scoped durable JSON,
// lands in opencode.db's kv table; read it read-only with sqlite).
// Flush-time read-merge-write with a process-local baseline: two concurrent
// opencode servers sharing the db no longer overwrite each other's snapshot
// (no CAS exists; the single get..set window remains, counts are advisory).
// Every storage failure is swallowed: telemetry must never change behaviour.

const STATS_KEY = "stats";

type FixKey =
  | `path.${TempMechanism}`
  | "path.other"
  | `glob.${TempMechanism}`
  | `patch.${TempMechanism}`
  | "patch.other"
  | `shell.workdir.${TempMechanism}`
  | "shell.workdir.other";

interface Stats {
  schema: 1;
  since: string;
  toolCalls: Record<string, number>;
  fixes: Record<string, number>;
}

let stats: Stats | null = null;
let statsBaseline: Stats | null = null;
let saveStats: (() => Promise<void>) | null = null;
let statsTimer: ReturnType<typeof setTimeout> | undefined;
let statsWrite: Promise<void> = Promise.resolve(); // serialization tail

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

// latest = the store's value at flush time (possibly another process's
// write); current = ours (baseline + this process's increments). The result
// keeps the store's since and adds our per-key delta, re-based after every
// flush so a repeated flush never double-counts.
function mergeStats(latest: unknown, current: Stats, baseline: Stats): Stats {
  const ok =
    latest && typeof latest === "object" &&
    (latest as Partial<Stats>).schema === 1 &&
    typeof (latest as Partial<Stats>).since === "string";
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
    // chain onto the previous write: two racing .set calls could otherwise
    // persist the older snapshot last
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
    statsTimer = setTimeout(flushStats, 5000); // batched: every call must not pay a write
    statsTimer.unref?.(); // never keep a process alive just for telemetry
  }
}

function bumpFix(key: FixKey): void {
  if (!stats) return;
  stats.fixes[key] = (stats.fixes[key] ?? 0) + 1;
  flushStats(); // numerators are rare: persist at once
}

// ---- OpenCode hook wiring --------------------------------------------------
// Surfaces (wiring measured on v2.2.5; sources in docs/spec.md):
//   ctx.tool.hook("execute.before")  -> event.input for the file tools:
//     `path`, `patch.patchText` (paths live in its directive lines), and a
//     `glob.pattern` whose temp prefix becomes `path`. The host resolves
//     these paths itself (no MSYS mapping), so the rewrite belongs there.
//   ctx.shell.hook("create.before")  -> event.command / event.cwd;
//     `command` is NEVER rewritten (no scanner any more); only `cwd` (the
//     unresolved workdir). `shell` names the executable it will spawn, so
//     the workdir rewrite is gated on that shell being a verified MSYS bash.

const PATH_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);

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
      // bumps mutate `stats` in place, an aliased baseline zeroes every delta
      statsBaseline = statsSnapshot();
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
      // a missing tool name fails safe: no rewrite, never a TypeError
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
      // String contract guards: a non-string shell cannot be verified. No
      // host non-string has ever been measured on v2.2.5 -- defensive parity,
      // chosen because a TypeError from this hook breaks the spawn itself.
      if (typeof event.shell !== "string" || !isMsysShell(event.shell)) return;
      bumpTool("bash");
      // `workdir` reaches this hook unresolved (`/tmp`) and the host checks
      // it with Windows semantics afterwards ("Working directory does not
      // exist: C:\tmp" -- measured), so the same temp forms rewrite to the
      // anchor bash itself uses.
      if (typeof event.cwd === "string") {
        const fix = rewritePathFix(event.cwd);
        if (fix.value !== event.cwd) {
          event.cwd = fix.value;
          bumpFix(fix.mechanism ? `shell.workdir.${fix.mechanism}` : "shell.workdir.other");
        }
      }
      // event.command is deliberately NOT touched: the input-side scanner
      // (cmdFlag/envp rewrites) was removed in the 2026-11-05 redesign --
      // docs/oc-env-guard-redesign.md.
    });

    // unload: flush what the debounce still holds. Returning the promise
    // lets the host await the final write (Cleanup = () => Promise<void> | void).
    return () => flushStats();
  },
});
