// native-powershell tests.
//
//   node pi-extensions/tests/native-powershell/index.mjs      (or: npm run test:pi)
//
// The suite runs the real powershell executable and looks at how it is actually
// spawned, not at what the source says. Checks that need a Windows PowerShell are
// reported as SKIPPED (never as passed) when none is installed, so a machine
// without pwsh cannot report a false green.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const srcPath = join(here, '..', '..', 'native-powershell', 'index.ts');
const scratch = mkdtempSync(join(tmpdir(), 'native-powershell-'));
// Host stand-in: the real argument list (POWERSHELL_ARGS) so the flag stripping is
// exercised, and a shell taken from the environment so the suite controls which
// executable is spawned.
const stub = `const HOST_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];\nconst getPowerShellConfig = () => { if (process.env.NPS_NO_PS) throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH."); return { shell: process.env.NPS_SHELL ?? "pwsh", args: [...HOST_ARGS] }; };\nconst createPowerShellTool = (cwd, options) => ({ __stub: true, name: "powershell", cwd, operations: options?.operations, promptSnippet: "s", promptGuidelines: ["g"] });`;
const src = readFileSync(srcPath, 'utf8').replace('import { createPowerShellTool, getPowerShellConfig } from "@earendil-works/pi-coding-agent";', stub);
writeFileSync(join(scratch, 'index.ts'), src, 'utf8');
const mod = await import(pathToFileURL(join(scratch, 'index.ts')).href);

const checks = [];
const check = (label, ok, detail = '') => checks.push({ label, ok: !!ok, skipped: false, detail });
const skip = (label, why) => checks.push({ label, ok: true, skipped: true, detail: why });

// ---- locating the installed host package ------------------------------------
// The extension copies four things the host keeps private: the UTF-8 prefix, the
// settlement grace, the timeout bound and the two flag names. Those copies cannot
// follow a host upgrade by themselves, so the suite compares them against the host
// package that is actually installed and names the version it compared against.
// Nothing is read from a hardcoded path: candidates come from NPS_PI_ROOT, from the npm
// prefix in the environment, from the directories above the Node executable, and from
// the repository. When none of them holds the host package the comparisons are
// SKIPPED, never reported as passed.
const HOST_IMPORT = 'import { createPowerShellTool, getPowerShellConfig } from "@earendil-works/pi-coding-agent";';

function findHostPackage() {
  const target = ['@earendil-works', 'pi-coding-agent'];
  const hasPkg = dir => existsSync(join(dir, 'package.json'));
  const below = nodesRoot => {
    const direct = join(nodesRoot, ...target);
    if (hasPkg(direct)) return direct;
    let scopes = [];
    try {
      scopes = readdirSync(nodesRoot, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('@')).map(d => join(nodesRoot, d.name));
    } catch { return null; }
    // One level down: node_modules/@scope/name/node_modules/@earendil-works/pi-coding-agent
    for (const scope of scopes) {
      let names = [];
      try {
        names = readdirSync(scope, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
      } catch { continue; }
      for (const name of names) {
        const candidate = join(scope, name, 'node_modules', ...target);
        if (hasPkg(candidate)) return candidate;
      }
    }
    return null;
  };
  const nodesRoots = [];
  if (process.env.NPS_PI_ROOT) {
    if (hasPkg(process.env.NPS_PI_ROOT)) return process.env.NPS_PI_ROOT;
    nodesRoots.push(process.env.NPS_PI_ROOT);
  }
  // npm's global prefix, without spawning npm: under `npm run` the prefix is in the
  // environment, and %APPDATA%\npm is the default location on Windows.
  for (const prefix of [process.env.npm_config_global_prefix, process.env.npm_config_prefix, process.env.APPDATA && join(process.env.APPDATA, 'npm')]) {
    if (prefix) nodesRoots.push(join(prefix, 'node_modules'));
  }
  // Wherever Node itself lives: a global install puts its packages beside the
  // executable or in a bin directory next to it.
  let base = dirname(process.execPath);
  for (let level = 0; level < 4 && base !== dirname(base); level += 1) {
    nodesRoots.push(join(base, 'node_modules'), join(base, 'bin', 'node_modules'));
    base = dirname(base);
  }
  nodesRoots.push(join(root, 'node_modules'));
  for (const nodesRoot of nodesRoots) {
    const found = below(nodesRoot);
    if (found) return found;
  }
  return null;
}

const DRIFT_LABELS = [
  'real host factory registers a powershell tool with execute',
  'real host factory spawns without -NoProfile and -ExecutionPolicy',
  'real host factory keeps the UTF-8 prefix',
  'real host factory returns non-ASCII unchanged',
  'real host factory reports a non-zero exit code',
  'the host still passes the two flags this extension removes',
  'the host still ends its list with -Command (the transport this module assumes)',
  'startArguments drops only those two flags from the real host list',
  'the UTF-8 prefix copy still matches the host',
  'the settlement grace copy still matches the host',
  'the timeout bound copy still matches the host',
];

const LIVE_LABELS = [
  'spawn args: -NonInteractive and the UTF-8 prefix kept, -NoProfile/-ExecutionPolicy dropped',
  'native spawn matches a direct pwsh call with the same arguments',
  'exit code preserves PowerShell exit 2',
  'output code page is UTF-8 (host prefix)',
  'non-ASCII passthrough is UTF-8',
  'env option reaches the child',
  'settles when a descendant holds the inherited pipes',
  'settles for cmd start /b background launch',
  'timeout above the setTimeout bound is rejected, not overflowed',
  'timeout 0 is rejected',
  'timeout rejects with timeout:1',
  'abort rejects after aborting child tree',
  'missing working directory is reported',
  'abort wins over the working-directory check (host order)',
  'host choice prompt fails fast under -NonInteractive',
  'Get-Credential fails fast under -NonInteractive',
  'Read-Host throws NonInteractive (no silent empty pass)',
];

try {
  // ---- packaging: the extension has to be installable and self-contained ------
  const pkgPath = join(here, '..', '..', 'package.json');
  check('P: pi-extensions/package.json readable', existsSync(pkgPath), pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    check(`P: no ${field} (install pulls nothing)`, pkg[field] === undefined, JSON.stringify(pkg[field]));
  }
  const targets = pkg.pi?.extensions ?? [];
  check('P: pi.extensions declares an extension', targets.length > 0, JSON.stringify(targets));
  for (const target of targets) {
    check(`P: extension target exists (${target})`, existsSync(join(here, '..', '..', target, 'index.ts')), target);
  }
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  check('P: root package re-exports pi-extensions', (rootPkg.pi?.extensions ?? []).includes('./pi-extensions'), JSON.stringify(rootPkg.pi?.extensions));

  // ---- wiring -----------------------------------------------------------------
  let registered;
  mod.default({ on: () => {}, registerTool: t => { registered = t; } });
  check('wiring registers powershell with operations', registered?.name === 'powershell' && !!registered.operations);

  // Argument handling, without spawning anything.
  const hostArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
  const stripped = JSON.stringify(mod.startArguments(hostArgs));
  check('startArguments drops exactly the two flags', stripped === JSON.stringify(['-NonInteractive', '-Command']), stripped);
  const unknown = ['-NoProfile', '-NonInteractive', '-WorkingDirectory', 'C:\\', '-Command'];
  const kept = JSON.stringify(mod.startArguments(unknown));
  check('startArguments keeps host flags it does not know', kept === JSON.stringify(['-NonInteractive', '-WorkingDirectory', 'C:\\', '-Command']), kept);

  // The host registers the tool whether or not an executable exists and reports the
  // missing shell from exec; this extension keeps that shape instead of going inert.
  process.env.NPS_NO_PS = '1';
  const gateOn = await import(pathToFileURL(join(scratch, 'index.ts')).href + '?gate-on');
  let count = 0;
  gateOn.default({ on: () => {}, registerTool: () => count++ });
  check('tool stays registered when no executable is installed', count === 1);
  const missingShell = await gateOn
    .createNativePowerShellOperations()
    .exec('exit 0', process.cwd(), { onData: () => {} })
    .then(() => '(resolved)', e => String(e.message));
  check('missing executable surfaces the host message at exec time', missingShell.startsWith('No PowerShell executable found'), missingShell);
  delete process.env.NPS_NO_PS;

  const found = process.platform === 'win32' ? spawnSync('where.exe', ['pwsh'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0] : '';
  if (found) {
    process.env.NPS_SHELL = found;
    const live = await import(pathToFileURL(join(scratch, 'index.ts')).href + '?live');
    const ops = live.createNativePowerShellOperations();
    const run = async (cmd, opts = {}, dir = process.cwd()) => {
      let out = '';
      const t0 = Date.now();
      try {
        const r = await ops.exec(cmd, dir, { ...opts, onData: b => { out += Buffer.isBuffer(b) ? b.toString('utf8') : b; } });
        return { out, ms: Date.now() - t0, ...r };
      } catch (e) { return { out, ms: Date.now() - t0, error: e.message }; }
    };

    // The host prepends UTF8_OUTPUT_PREFIX to every command; this extension keeps it so
    // the two flags are the only difference from the built-in tool.
    const PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';
    const introspect = '(Get-Process -Id $PID).CommandLine';
    const introspection = await run(introspect);
    const spawnArgs = introspection.out;
    check(
      'spawn args: -NonInteractive and the UTF-8 prefix kept, -NoProfile/-ExecutionPolicy dropped',
      spawnArgs.includes('-NonInteractive')
        && spawnArgs.includes('try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}')
        && !['-NoProfile', '-ExecutionPolicy', 'Bypass'].some(flag => spawnArgs.includes(flag)),
      spawnArgs.slice(0, 300),
    );
    const direct = await new Promise(resolve => {
      const c = spawn(found, ['-NonInteractive', '-Command', PREFIX + introspect], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      c.stdout.on('data', b => out += b.toString('utf8'));
      c.on('close', () => resolve(out));
    });
    check('native spawn matches a direct pwsh call with the same arguments', introspection.out.replace(found, '<pwsh>').includes(direct.replace(found, '<pwsh>').trim()));
    check('exit code preserves PowerShell exit 2', (await run('exit 2')).exitCode === 2);
    // The prefix decides the code page on its own, so this pair does not depend on the
    // deployed $PROFILE and is a real check rather than an environment prerequisite.
    const codePage = await run('[Console]::OutputEncoding.CodePage');
    check('output code page is UTF-8 (host prefix)', codePage.out.trim() === '65001', codePage.out.trim());
    const unicode = await run('Write-Output 漢字');
    check('non-ASCII passthrough is UTF-8', unicode.out.includes('漢字'), JSON.stringify(unicode.out));
    const env = await run('$env:NPS_TEST_MARK', { env: { ...process.env, NPS_TEST_MARK: 'yes' } });
    check('env option reaches the child', env.out.trim() === 'yes', JSON.stringify(env.out));

    // Settlement: a descendant that inherits our pipes must not hold the call open
    // (the host settles on exit + a 100ms idle grace, not on pipe close).
    const lingered = await run("Start-Process -NoNewWindow pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 15'; Write-Output launched");
    check('settles when a descendant holds the inherited pipes', lingered.out.includes('launched') && lingered.ms < 5000, `${lingered.ms}ms`);
    const started = await run('cmd /c start /b pwsh -NoProfile -Command "Start-Sleep -Seconds 12"; Write-Output launched');
    check('settles for cmd start /b background launch', started.out.includes('launched') && started.ms < 5000, `${started.ms}ms`);

    // Timeout validation, in the host's order and with the host's messages.
    const overflow = await run('exit 0', { timeout: 3e9 });
    check('timeout above the setTimeout bound is rejected, not overflowed', String(overflow.error).startsWith('Invalid timeout: maximum is'), String(overflow.error));
    const zero = await run('exit 0', { timeout: 0 });
    check('timeout 0 is rejected', String(zero.error).startsWith('Invalid timeout: must be a finite number of seconds'), String(zero.error));
    // `run` folds a rejection into { error }, so these checks read that field; the
    // guard timer keeps a regression from hanging the whole suite.
    const guard = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('test guard timeout')), 15000))]).catch(e => ({ error: e.message }));
    const timedOut = await guard(run('Start-Sleep -Sec 30', { timeout: 1 }));
    check('timeout rejects with timeout:1', String(timedOut.error).startsWith('timeout:1'), String(timedOut.error));

    const aborted = await guard((async () => { const ac = new AbortController(); const p = run('Start-Sleep -Sec 30', { signal: ac.signal }); setTimeout(() => ac.abort(), 300); return p; })());
    check('abort rejects after aborting child tree', aborted.error === 'aborted', String(aborted.error));

    const missing = await run('exit 0', {}, join(process.cwd(), 'nps-no-such-dir'));
    check('missing working directory is reported', String(missing.error).startsWith('Working directory does not exist:'), String(missing.error));
    const preAborted = new AbortController();
    preAborted.abort();
    const precedence = await run('exit 0', { signal: preAborted.signal }, join(process.cwd(), 'nps-no-such-dir'));
    check('abort wins over the working-directory check (host order)', precedence.error === 'aborted', String(precedence.error));

    // -NonInteractive regression: host prompts must fail fast instead of hanging
    // the tool call (Get-Credential opened a desktop dialog for >8s without it).
    const promptCases = [
      ['host choice prompt fails fast under -NonInteractive', '$Host.UI.PromptForChoice(\'t\',\'m\',[System.Management.Automation.Host.ChoiceDescription[]]@([System.Management.Automation.Host.ChoiceDescription]\'&Yes\',\'&No\'),0)', out => out.includes('NonInteractive')],
      ['Get-Credential fails fast under -NonInteractive', '$null = Get-Credential -Message x', out => !out.includes('got credential')],
      ['Read-Host throws NonInteractive (no silent empty pass)', '$r = Read-Host \'x\'; "empty=$($null -eq $r) len=$($r.Length)"', out => out.includes('NonInteractive')],
    ];
    for (const [label, command, assertOut] of promptCases) {
      try {
        const r = await Promise.race([
          run(command, { timeout: 8 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('hung; must fail fast')), 10000)),
        ]);
        check(label, assertOut(r.out), r.out.slice(0, 200));
      } catch (e) { check(label, false, String(e.message)); }
    }
  } else {
    for (const label of LIVE_LABELS) skip(`${label} (no Windows pwsh on PATH)`, 'no PowerShell executable');
  }

  // ---- drift guard: the copies this extension keeps from the host --------------
  // The default export is exercised against the host's own factory and tool object, so a
  // host change in how `operations` is forwarded shows up here instead of silently
  // bringing the two flags back.
  const hostPkgDir = findHostPackage();
  if (hostPkgDir) {
    const hostVersion = JSON.parse(readFileSync(join(hostPkgDir, 'package.json'), 'utf8')).version;
    const at = `compared against pi ${hostVersion}`;
    const hostIndex = pathToFileURL(join(hostPkgDir, 'dist', 'index.js')).href;
    // Rewrite only the host import, so the default export runs against the real factory.
    const wiredSrc = readFileSync(srcPath, 'utf8').replace(
      HOST_IMPORT,
      `const { createPowerShellTool, getPowerShellConfig } = await import(${JSON.stringify(hostIndex)});`,
    );
    const wiredFile = join(scratch, 'wired.ts');
    writeFileSync(wiredFile, wiredSrc, 'utf8');
    const wired = await import(pathToFileURL(wiredFile).href);
    let realTool;
    wired.default({ on: () => {}, registerTool: tool => { realTool = tool; } });
    check(`D: ${DRIFT_LABELS[0]} (${at})`, realTool?.name === 'powershell' && typeof realTool.execute === 'function', String(realTool?.name));
    // The tool object needs a session context for the PI_* variables; passing none keeps
    // the call limited to the parts this extension replaces.
    const callTool = async (command, extra = {}) => {
      try {
        const result = await realTool.execute('drift', { command, ...extra }, undefined, undefined, undefined);
        return { text: (result?.content ?? []).map(part => part.text ?? '').join('') };
      } catch (e) {
        return { text: '', error: String(e?.message ?? e) };
      }
    };
    const spawnLine = await callTool('(Get-Process -Id $PID).CommandLine');
    check(
      `D: ${DRIFT_LABELS[1]} (${at})`,
      spawnLine.text.includes('-Command')
        && !['-NoProfile', '-ExecutionPolicy', 'Bypass'].some(flag => spawnLine.text.includes(flag)),
      spawnLine.text.trim().slice(0, 200),
    );
    const hostCodePage = await callTool('[Console]::OutputEncoding.CodePage');
    check(`D: ${DRIFT_LABELS[2]} (${at})`, hostCodePage.text.trim() === '65001', hostCodePage.text.trim());
    const hostUnicode = await callTool('Write-Output 漢字AB');
    check(`D: ${DRIFT_LABELS[3]} (${at})`, hostUnicode.text.includes('漢字AB'), JSON.stringify(hostUnicode.text.trim()));
    const hostExit = await callTool('exit 7');
    check(`D: ${DRIFT_LABELS[4]} (${at})`, /code 7/.test(hostExit.text), JSON.stringify(hostExit.error ?? hostExit.text.trim().slice(0, 120)));

    // The flag names themselves: if the host renames or stops passing them, the filter
    // silently stops removing anything, so the host list is read back from its source.
    const hostShellSrc = readFileSync(join(hostPkgDir, 'dist', 'utils', 'shell.js'), 'utf8');
    const hostArgsMatch = hostShellSrc.match(/export const POWERSHELL_ARGS = (\[[^\]]*\]);/);
    const hostArgs = hostArgsMatch ? JSON.parse(hostArgsMatch[1]) : [];
    check(
      `D: ${DRIFT_LABELS[5]} (${at})`,
      hostArgs.includes('-NoProfile') && hostArgs.includes('-ExecutionPolicy'),
      JSON.stringify(hostArgs),
    );
    const filtered = JSON.stringify(mod.startArguments(hostArgs));
    check(
      `D: ${DRIFT_LABELS[6]} (${at})`,
      !filtered.includes('-NoProfile') && !filtered.includes('-ExecutionPolicy')
        && !filtered.includes('Bypass') && filtered.includes('-NonInteractive') && filtered.includes('-Command'),
      filtered,
    );
    // Filtering the host's list follows the host, which also means following the host into
    // a shape this module does not build: the command is appended as the last argument, so
    // the list has to end with -Command rather than a stdin transport flag.
    check(
      `D: ${DRIFT_LABELS[7]} (${at})`,
      hostArgs[hostArgs.length - 1] === '-Command',
      JSON.stringify(hostArgs),
    );

    const hostPrefixSrc = readFileSync(join(hostPkgDir, 'dist', 'core', 'tools', 'powershell.js'), 'utf8');
    const hostPrefixMatch = hostPrefixSrc.match(/const UTF8_OUTPUT_PREFIX = ("(?:[^"\\]|\\.)*");/);
    const hostPrefix = hostPrefixMatch ? JSON.parse(hostPrefixMatch[1]) : null;
    const modulePrefixMatch = src.match(/const UTF8_OUTPUT_PREFIX = ("(?:[^"\\]|\\.)*");/);
    const modulePrefix = modulePrefixMatch ? JSON.parse(modulePrefixMatch[1]) : null;
    check(
      `D: ${DRIFT_LABELS[8]} (${at})`,
      hostPrefix !== null && hostPrefix === modulePrefix,
      JSON.stringify({ host: hostPrefix, module: modulePrefix }),
    );

    const number = text => Number(String(text ?? '').replace(/_/g, ''));
    const hostChildSrc = readFileSync(join(hostPkgDir, 'dist', 'utils', 'child-process.js'), 'utf8');
    const hostGrace = number((hostChildSrc.match(/const EXIT_STDIO_GRACE_MS = ([\d_]+);/) ?? [])[1]);
    const moduleGrace = number((src.match(/const EXIT_STDIO_GRACE_MS = ([\d_]+)/) ?? [])[1]);
    check(
      `D: ${DRIFT_LABELS[9]} (${at})`,
      hostGrace > 0 && hostGrace === moduleGrace,
      JSON.stringify({ host: hostGrace, module: moduleGrace }),
    );
    const hostBashSrc = readFileSync(join(hostPkgDir, 'dist', 'core', 'tools', 'bash.js'), 'utf8');
    const hostMax = number((hostBashSrc.match(/const MAX_TIMEOUT_MS = ([\d_]+);/) ?? [])[1]);
    const moduleMax = number((src.match(/const MAX_TIMEOUT_MS = ([\d_]+)/) ?? [])[1]);
    check(
      `D: ${DRIFT_LABELS[10]} (${at})`,
      hostMax > 0 && hostMax === moduleMax,
      JSON.stringify({ host: hostMax, module: moduleMax }),
    );
  } else {
    for (const label of DRIFT_LABELS) skip(`D: ${label}`, 'no installed pi package found (set NPS_PI_ROOT)');
  }

  // Transcode layer removal regression: no decoder/probe machinery of our own; the
  // encoding correction is the host's own prefix, copied verbatim.
  check('no decoder or code-page probe machinery in source', !/transcodeChunk|TextDecoder|probeOutputCodePage|codePageLabel/.test(src));
  check(
    'host UTF-8 prefix copied verbatim',
    src.includes('const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\\n";'),
  );
  check('-NonInteractive retention documented with hang evidence', /Why -NonInteractive stays/.test(src) && /Get-Credential/.test(src));
  check('settlement parity documented in source', src.includes('EXIT_STDIO_GRACE_MS') && src.includes('child.once("exit"'));
} catch (e) {
  check('test suite setup', false, String(e?.stack ?? e));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const failed = checks.filter(c => !c.ok);
const skipped = checks.filter(c => c.skipped);
for (const c of failed) console.error(`FAIL ${c.label}: ${c.detail}`);
for (const c of skipped) console.log(`SKIP ${c.label} (${c.detail})`);
console.log(`=== pi extensions: ${checks.length - failed.length - skipped.length} passed, ${skipped.length} skipped, ${failed.length} failed (${checks.length} checks) ===`);
if (failed.length) process.exitCode = 1;
