// Behavior battery for the pwsh-profile-loader plugin.
//
//   node opencode/tests/pwsh-profile-loader/index.mjs
//
// Two layers, both real:
//   1. The ACTUAL module is imported (Node native TS type-stripping), setup()
//      runs through a hook-capturing fake ctx, and the prefix is DERIVED from
//      the module's real mutation (sentinel round-trip) — no source parsing to
//      define behavior; source-text checks only pin the four-file chain.
//   2. The derived prefix is executed through real pwsh spawns: profile load,
//      exit passthrough, clean-env restoration, missing-profile inertness.
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const moduleDir = join(here, '..', '..', 'pwsh-profile-loader');

let pass = 0;
const failures = [];
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const check = (name, ok, detail) => { if (ok) pass++; else failures.push(`${name} -> ${detail}`); };

const moduleSrc = readFileSync(join(moduleDir, 'index.ts'), 'utf8');

// ---------- source-text pins (chain shape) ----------
check('L[src]: chain names all four native profile files',
  ['$PROFILE.AllUsersAllHosts', '$PROFILE.AllUsersCurrentHost', '$PROFILE.CurrentUserAllHosts', '"$PROFILE"']
    .every((f) => moduleSrc.includes(f))
  && moduleSrc.includes('Exists(%HOMEFILE%)'),
  moduleSrc.length);

// ---------- layer 1: drive the real module, derive the prefix ----------
let hookCb = null;
let mod = null;
const ctx = {shell: {hook: (name, cb) => { check('L[hook]: registers shell.create.before', name === 'create.before', name); hookCb = cb; }}};
try {
  mod = await import(pathToFileURL(join(moduleDir, 'index.ts')).href);
  await mod.default.setup(ctx);
  check('L[hook]: callback captured', typeof hookCb === 'function', typeof hookCb);
} catch (error) {
  check('L[hook]: module loads and setup runs', false, String(error));
}

// Inert gate: a missing hook surface (older oc build, odd host) must neither
// throw nor register — the plugin simply stays out of the way.
try {
  await mod.default.setup({});
  await mod.default.setup({shell: {}});
  check('L[setup]: missing hook surface is inert (no throw)', true, 'no throw');
} catch (error) {
  check('L[setup]: missing hook surface is inert (no throw)', false, String(error));
}

let prefix = null;
if (typeof hookCb === 'function') {
  // T1: pwsh.exe -> prefixed, original command preserved verbatim (prefix derived).
  const s1 = 'Write-Output hi';
  const e1 = {shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', command: s1};
  hookCb(e1);
  prefix = e1.command.endsWith(s1) ? e1.command.slice(0, e1.command.length - s1.length) : '';
  check('L[T1]: prefixed on pwsh.exe (derived prefix length > 0)', prefix.length > 0, JSON.stringify(e1.command));
  // runtime chain shape: the ACTUAL prefix must cover all four files, each
  // guarded, each reporting failures on stderr.
  check('L[chain]: prefix covers all four native profile files',
    ['$PROFILE.AllUsersAllHosts', '$PROFILE.AllUsersCurrentHost', '$PROFILE.CurrentUserAllHosts']
      .every((f) => prefix.includes(`Exists(${f})`) && prefix.includes(`. ${f}`))
    && prefix.includes('Exists($PROFILE))') && prefix.includes('. $PROFILE}'),
    prefix);
  check('L[chain]: four native passthrough catches, no invented marker/format',
    (prefix.match(/catch\{\$o=\$ErrorActionPreference;\$ErrorActionPreference='Continue';Write-Error -ErrorRecord \$_;\$ErrorActionPreference=\$o;\}/g) || []).length === 4
    && !prefix.includes('[pwsh-profile-loader]'),
    prefix);
  // T2: powershell.exe (5.1) -> same treatment.
  {
    const cmd = 'gci';
    const e2 = {shell: 'C:\\Windows\\System32\\WindowsPowerShell\\1.0\\powershell.exe', command: cmd};
    hookCb(e2);
    check('L[T2]: prefixed on powershell.exe', e2.command === prefix + cmd, JSON.stringify(e2.command));
  }
  // T3: non-pwsh shells untouched.
  {
    const e3 = {shell: 'C:\\Program Files\\Git\\bin\\bash.exe', command: 'echo hi'};
    hookCb(e3);
    check('L[T3]: bash untouched', e3.command === 'echo hi', JSON.stringify(e3.command));
  }
  // T4: non-string / empty commands untouched (inert, no crash).
  {
    const a = {shell: 'pwsh.exe', command: 42}; hookCb(a);
    const b = {shell: 'pwsh.exe', command: ''}; hookCb(b);
    const c = {}; hookCb(c);
    check('L[T4]: non-string/empty/missing command untouched',
      a.command === 42 && b.command === '' && !('command' in c),
      JSON.stringify([a.command, b.command, 'command' in c]));
  }
  // T5: idempotent re-entry (double registration) does not double-prefix.
  {
    const e5 = {shell: 'pwsh.exe', command: prefix + 'gci'};
    hookCb(e5);
    check('L[T5]: idempotent', e5.command === prefix + 'gci', JSON.stringify(e5.command));
  }
}

// ---------- layer 2: real pwsh end-to-end through the derived prefix ----------
const run = (cmd, env) => spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd],
  {windowsHide: true, encoding: 'utf8', timeout: 60000, env: env ? {...env} : undefined});

if (process.platform === 'win32' && prefix) {
  // T6: exit code passthrough with the prefix.
  {
    const r = run(prefix + 'exit 7');
    check('L[T6]: exit code 7 passthrough with prefix', r.status === 7, `status=${String(r.status)}`);
  }
  // T7: profile genuinely loads — its git-bash bin is re-added to the FRONT of
  // PATH when absent. Control spawn (no prefix) has no such restoration.
  {
    const stripped = {...process.env};
    const pathKey = Object.keys(stripped).find((k) => k.toUpperCase() === 'PATH');
    stripped[pathKey] = stripped[pathKey].split(';')
      .filter((p) => !/scoop\\apps\\git\\[\d.]+\\bin\\?$/i.test(p))
      .join(';');
    const probe = 'Write-Output (($env:PATH -split ";")[0])';
    const head = (r) => String(r.stdout ?? '').trim();
    const gitBinHead = /scoop\\apps\\git\\[\d.]+\\bin$/i;
    const control = run(probe, stripped);
    check('L[T7]: control (no prefix) head is not git bin', !gitBinHead.test(head(control)), head(control));
    const withPrefix = run(prefix + probe, stripped);
    check('L[T7]: prefix loads profile, git bin becomes PATH head', gitBinHead.test(head(withPrefix)), head(withPrefix));
  }
  // T8: all-chain inertness with a missing profile — prefix must not fail or
  // block the command; nothing on stderr either.
  {
    const r = run('$PROFILE="C:\\nonexistent-profile-xyz.ps1"; ' + prefix + 'Write-Output ok-step');
    check('L[T8]: missing profile inert (exit 0)', r.status === 0, `status=${String(r.status)}`);
    check('L[T8]: command after prefix still runs', String(r.stdout ?? '').includes('ok-step'), String(r.stdout ?? ''));
  }
  // T9: a FAILING profile must be directly diagnosable, not silent — stderr
  // carries the plugin marker, which file, and the message; the command still runs.
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ppl-t9-'));
    const badFile = join(tmpDir, 'bad-profile.ps1');
    writeFileSync(badFile, "throw 'boom-from-profile'\r\n", 'utf8');
    const r = run(`$PROFILE="${badFile}"; ` + prefix + 'Write-Output ok-after');
    const err = String(r.stderr ?? '');
    const out = String(r.stdout ?? '');
    check('L[T9]: failing profile surfaces the native error view (no invented format)',
      stripAnsi(err).includes('Exception: boom-from-profile') && !err.includes('[pwsh-profile-loader]'), err);
    check('L[T9]: command after failing profile still runs', r.status === 0 && out.includes('ok-after'),
      `status=${String(r.status)} out=${out}`);
    rmSync(tmpDir, {recursive: true, force: true});
  }
  // T10: scoping parity — what the profile leaves behind (variables, functions)
  // is usable by the command itself, exactly like the native loader stage.
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ppl-t10-'));
    const prof = join(tmpDir, 'scope-profile.ps1');
    writeFileSync(prof, '$ppProbe = 42\r\nfunction pp-fn { "pp-fn-works" }\r\n', 'utf8');
    const r = run(`$PROFILE="${prof}"; ` + prefix + 'Write-Output $ppProbe; pp-fn');
    const out = String(r.stdout ?? '');
    check('L[T10]: profile-defined variable visible to the command', out.includes('42'), out);
    check('L[T10]: profile-defined function callable by the command', out.includes('pp-fn-works'), out);
    rmSync(tmpDir, {recursive: true, force: true});
  }
}

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== oc pwsh-profile-loader battery: ${pass} passed, ${failures.length} failed ===`);
process.exit(failures.length === 0 ? 0 : 1);
