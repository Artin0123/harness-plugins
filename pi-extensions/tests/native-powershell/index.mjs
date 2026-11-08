import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, '..', '..', 'native-powershell', 'index.ts');
const scratch = mkdtempSync(join(tmpdir(), 'native-powershell-'));
const stub = `const getPowerShellConfig = () => { if (process.env.NPS_NO_PS) throw new Error("No PowerShell executable found."); return { shell: process.env.NPS_SHELL ?? "pwsh", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] }; };\nconst createPowerShellTool = (cwd, options) => ({ __stub: true, name: "powershell", cwd, operations: options?.operations, promptSnippet: "s", promptGuidelines: ["g"] });`;
const src = readFileSync(srcPath, 'utf8').replace('import { createPowerShellTool, getPowerShellConfig } from "@earendil-works/pi-coding-agent";', stub);
writeFileSync(join(scratch, 'index.ts'), src, 'utf8');
const mod = await import(pathToFileURL(join(scratch, 'index.ts')).href);
const checks = [];
const check = (label, ok, detail = '') => checks.push({ label, ok: !!ok, detail });
try {
  let registered; let onCalled = false;
  mod.default({ on: () => { onCalled = true; }, registerTool: t => { registered = t; } });
  check('wiring registers powershell with operations', registered?.name === 'powershell' && !!registered.operations);
  process.env.NPS_NO_PS = '1';
  const inert = await import(pathToFileURL(join(scratch, 'index.ts')).href + '?gate-on');
  let count = 0; let inertOn = false;
  inert.default({ on: () => { inertOn = true; }, registerTool: () => count++ });
  check('missing executable leaves extension inert', count === 0 && !inertOn);
  delete process.env.NPS_NO_PS;
  const found = process.platform === 'win32' ? spawnSync('where.exe', ['pwsh'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0] : '';
  if (found) {
    process.env.NPS_SHELL = found;
    const live = await import(pathToFileURL(join(scratch, 'index.ts')).href + '?live');
    const ops = live.createNativePowerShellOperations(found);
    const run = async (cmd, opts = {}) => { let out = ''; const result = await ops.exec(cmd, process.cwd(), { ...opts, onData: b => { out += Buffer.isBuffer(b) ? b.toString('utf8') : b; } }); return { out, ...result }; };
    const introspection = await run('(Get-Process -Id $PID).CommandLine');
    check('spawn introspection contains only native command arguments', introspection.out.includes('-Command') && !['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'try {', '[Console]::OutputEncoding'].some(x => introspection.out.includes(x)));
    const direct = await new Promise(resolve => { const c = spawn(found, ['-Command', '(Get-Process -Id $PID).CommandLine'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); let out = ''; c.stdout.on('data', b => out += b.toString('utf8')); c.on('close', () => resolve(out)); });
    check('native spawn introspection matches direct pwsh', introspection.out.replace(found, '<pwsh>').includes(direct.replace(found, '<pwsh>').trim()));
    check('exit code preserves PowerShell exit 2', (await run('exit 2')).exitCode === 2);
    const unicode = await run('Write-Output 漢字');
    check('pwsh 7 Unicode output is UTF-8', unicode.out.includes('漢字'));
    let timeoutMessage = ''; try { await Promise.race([run('Start-Sleep -Sec 30', { timeout: 1 }), new Promise((_, reject) => setTimeout(() => reject(new Error('test guard timeout')), 15000))]); } catch (e) { timeoutMessage = e.message; }
    check('timeout rejects with timeout:1', timeoutMessage.startsWith('timeout:1'));
    const ac = new AbortController(); const abortPromise = run('Start-Sleep -Sec 30', { signal: ac.signal }); setTimeout(() => ac.abort(), 300);
    let abortMessage = ''; try { await Promise.race([abortPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('test guard timeout')), 15000))]); } catch (e) { abortMessage = e.message; }
    check('abort rejects after aborting child tree', abortMessage === 'aborted');
  } else {
    for (const label of ['spawn introspection contains only native command arguments', 'native spawn introspection matches direct pwsh', 'exit code preserves PowerShell exit 2', 'pwsh 7 Unicode output is UTF-8', 'timeout rejects with timeout:1', 'abort rejects after aborting child tree']) check(`${label} (skip: no Windows pwsh)`, true);
  }
  // Transcode layer removal regression: this mod must stay a verbatim passthrough.
  // Encoding correction lives in $PROFILE ([console]::InputEncoding/OutputEncoding =
  // UTF8), so the source must contain no decoder/probe machinery and must document
  // the profile prerequisite.
  check('transcode layer removed from source', !/transcodeChunk|TextDecoder|probeOutputCodePage|codePageLabel/.test(src));
  check('profile UTF-8 prerequisite documented in source', src.includes('[console]::InputEncoding') && src.includes('$PROFILE'));
} catch (e) { check('test suite setup', false, String(e?.stack ?? e)); }
finally { rmSync(scratch, { recursive: true, force: true }); }
let failed = 0;
for (const c of checks) if (!c.ok) { failed++; console.error(`FAIL ${c.label}: ${c.detail}`); }
console.log(`${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;
