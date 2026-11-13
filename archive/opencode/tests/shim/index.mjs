// Behavior battery for the pwsh-profile-shim plugin.
//
//   node opencode/tests/shim/index.mjs
//
// Ground rules (AGENTS.md discipline): every case runs the REAL pipeline —
// the in-box compiler compiles opencode/pwsh-profile-shim/shim-src.cs, and
// every assertion goes through the compiled exe (node -> spawn -> shim ->
// CreateProcess target), never through a re-implementation of the logic.
//
// Exit codes: forwarded from the target process. Data channel: target output
// (an argv-echo stub verifies the re-quoting is byte-faithful), stderr, and
// the process exit code.
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const moduleDir = join(here, '..', '..', 'pwsh-profile-shim');

let pass = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) pass++; else failures.push(`${name} -> ${detail}`); };

// ---------- environment gate (same inert conditions the plugin uses) ----------
const windir = process.env.windir;
const csc = join(windir ?? '', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (process.platform !== 'win32' || !existsSync(csc)) {
  console.log('  SKIP: not win32 or no in-box csc; battery is Windows-specific');
  process.exit(0);
}

// ---------- Craft the temp workspace ----------
const work = mkdtempSync(join(tmpdir(), 'oc-shim-test-'));
const compile = (sourceText, outName) => {
  const csPath = join(work, outName.replace(/\.exe$/, '.cs'));
  writeFileSync(csPath, sourceText, 'utf8');
  const outPath = join(work, outName);
  const r = spawnSync(csc, ['/nologo', '/target:exe', '/out:' + outPath, csPath], {
    windowsHide: true, encoding: 'utf8',
  });
  if (r.status !== 0 || !existsSync(outPath)) {
    throw new Error(`csc failed for ${outName}: ${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
  return outPath;
};

// shim-src.cs may exist with any line-ending style on the developer machine;
// the embedded copy is what the plugin deploys, so it is pinned first.
const csFile = readFileSync(join(moduleDir, 'shim-src.cs'), 'utf8');
const indexSrc = readFileSync(join(moduleDir, 'index.ts'), 'utf8');
const embedMatch = indexSrc.match(/const SHIM_CS = `([\s\S]*)`;/);
check('S[embed]: embedded copy exists', Boolean(embedMatch), 'SHIM_CS template not found');
const embedText = embedMatch ? embedMatch[1] : '';

const argvEchoSource = `
using System;
class Echo {
    static void Main(String[] args) {
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch (Exception) {}
        for (int i = 0; i < args.Length; i++) {
            Console.Write("ARGV[");
            Console.Write(i);
            Console.Write("]=");
            Console.WriteLine(args[i]);
        }
    }
}
`;

let echoExe = null;
let shimExe = null;
try {
  check('S[embed]: embedded source is byte-identical to shim-src.cs', embedText === csFile,
    `lengths ${embedText.length} vs ${csFile.length}`);
  echoExe = compile(argvEchoSource, 'argv-echo.exe');
  shimExe = compile(csFile, 'shim.exe');
  check('S[csc]: shim compiles from the canonical source', existsSync(shimExe), shimExe);
} catch (error) {
  check('S[csc]: compile stage', false, String(error));
}

if (echoExe && shimExe) {
  const runEcho = (env, argv) => {
    const r = spawnSync(shimExe, argv, {windowsHide: true, encoding: 'utf8', env: {...process.env, ...env}});
    const lines = String(r.stdout ?? '').split(/\r?\n/).filter((line) => line.startsWith('ARGV['));
    const forwarded = lines.map(decodeEchoLine);
    return {status: r.status, stderr: String(r.stderr ?? ''), forwarded};
  };
  const decodeEchoLine = (line) => line.slice(line.indexOf(']=') + 2);
  const envOf = (target) => ({OCPWSH_PATH: target});
  const runShim = (env, argv) => spawnSync(
    shimExe, argv,
    {windowsHide: true, encoding: 'utf8', env: {...process.env, ...env}},
  );

  // T1: the injected -NoProfile token is the ONLY thing dropped; order kept.
  {
    const {forwarded} = runEcho(envOf(echoExe),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'plain-arg']);
    check('S[T1]: drops -NoProfile, order and the rest verbatim',
      JSON.stringify(forwarded) === JSON.stringify(['-NoLogo', '-NonInteractive', '-Command', 'plain-arg']),
      JSON.stringify(forwarded));
  }

  // T2: token equality only (ordinal ignore case), anything longer stays.
  {
    const {forwarded} = runEcho(envOf(echoExe),
      ['-NOPROFILE', '-NoProfileSuffix', '-nofromprofile', 'arg']);
    check('S[T2]: case-insensitive exact-token match only',
      JSON.stringify(forwarded) === JSON.stringify(['-NoProfileSuffix', '-nofromprofile', 'arg']),
      JSON.stringify(forwarded));
  }

  // T3: standard argv re-quoting is byte-faithful through a real
  // CreateProcess round-trip (spaces, embedded quotes, also-trailing
  // backslashes, empty token, non-ASCII).
  {
    const cases = ['C:\\Program Files\\', 'a "b"', 'tail\\', '', 'x y', 'single', '中文"引號"\\'];
    const {forwarded} = runEcho(envOf(echoExe), cases);
    check('S[T3]: argv re-quoting round-trip', JSON.stringify(forwarded) === JSON.stringify(cases),
      JSON.stringify(forwarded));
  }

  // T4: exit code passthrough from the real target process.
  {
    const where = spawnSync('where', ['pwsh'], {encoding: 'utf8', windowsHide: true});
    const lines = String(where.stdout ?? '').split(/\r?\n/).filter((line) => existsSync(line.trim()));
    const found = lines.length > 0 ? lines[0].trim() : null;
    check('S[T4-prep]: pwsh resolvable', Boolean(found), String(where.stdout ?? where.stderr ?? ''));
    if (found) {
      const r = runShim(envOf(found), ['-NoProfile', '-NonInteractive', '-Command', 'exit 7']);
      check('S[T4]: exit code forwarded from real pwsh', r.status === 7, `status=${String(r.status)}`);
    }

    // T5: no OCPWSH_PATH -> PATH fallback for manual runs (still routes).
    {
      const env = {...process.env};
      delete env.OCPWSH_PATH;
      const r = spawnSync(shimExe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 4'],
        {windowsHide: true, encoding: 'utf8', env});
      check('S[T5]: missing env falls back to PATH pwsh', r.status === 4, `status=${String(r.status)}`);
    }

    // T6: broken target fails loudly (nonzero exit, stderr named the cause).
    {
      const r = runShim(envOf('C:\\nonexistent-target.exe'), ['-Command', 'exit 0']);
      check('S[T6]: unreachable target exits nonzero', r.status !== 0, `status=${String(r.status)}`);
      check('S[T6]: failure reported on stderr', /cannot spawn/.test(String(r.stderr ?? '')), String(r.stderr ?? ''));
    }
  }

  rmSync(work, {recursive: true, force: true});
}

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== oc shim battery: ${pass} passed, ${failures.length} failed ===`);
process.exit(failures.length === 0 ? 0 : 1);
