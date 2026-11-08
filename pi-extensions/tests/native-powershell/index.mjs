import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, '..', '..', 'native-powershell', 'index.ts');
const scratch = mkdtempSync(join(tmpdir(), 'native-powershell-'));
const stub = `const getPowerShellConfig = () => { if (process.env.NPS_NO_PS) throw new Error("No PowerShell executable found."); return { shell: process.env.NPS_SHELL ?? "pwsh" }; };\nconst createPowerShellTool = (cwd, options) => ({ __stub: true, name: "powershell", cwd, operations: options?.operations, promptSnippet: "s", promptGuidelines: ["g"] });`;
const src = readFileSync(srcPath, 'utf8').replace('import { createPowerShellTool, getPowerShellConfig } from "@earendil-works/pi-coding-agent";', stub);
writeFileSync(join(scratch, 'index.ts'), src, 'utf8');
const mod = await import(pathToFileURL(join(scratch, 'index.ts')).href);
const checks = [];
const check = (label, ok, detail = '') => checks.push({ label, ok: !!ok, detail });
try {
  let registered;
  mod.default({ on: () => {}, registerTool: t => { registered = t; } });
  check('wiring registers powershell with operations', registered?.name === 'powershell' && !!registered.operations);
  process.env.NPS_NO_PS = '1';
  const inert = await import(pathToFileURL(join(scratch, 'index.ts')).href + '?gate-on');
  let count = 0;
  inert.default({ on: () => {}, registerTool: () => count++ });
  check('missing executable leaves extension inert', count === 0);
  delete process.env.NPS_NO_PS;
  const found = process.platform === 'win32' ? spawnSync('where.exe', ['pwsh'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0] : '';
  if (found) {
    process.env.NPS_SHELL = found;
    const live = await import(pathToFileURL(join(scratch, 'index.ts')).href + '?live');
    const ops = live.createNativePowerShellOperations(found);
    const run = async (cmd, opts = {}) => { let out = ''; const result = await ops.exec(cmd, process.cwd(), { ...opts, onData: b => { out += Buffer.isBuffer(b) ? b.toString('utf8') : b; } }); return { out, ...result }; };
    const introspection = await run('(Get-Process -Id $PID).CommandLine');
    check('spawn introspection: -NonInteractive kept, no -NoProfile/-ExecutionPolicy/prefix', introspection.out.includes('-NonInteractive') && !['-NoProfile', '-ExecutionPolicy', 'try {', '[Console]::OutputEncoding'].some(x => introspection.out.includes(x)));
    const direct = await new Promise(resolve => { const c = spawn(found, ['-NonInteractive', '-Command', '(Get-Process -Id $PID).CommandLine'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); let out = ''; c.stdout.on('data', b => out += b.toString('utf8')); c.on('close', () => resolve(out)); });
    check('native spawn introspection matches direct pwsh', introspection.out.replace(found, '<pwsh>').includes(direct.replace(found, '<pwsh>').trim()));
    check('exit code preserves PowerShell exit 2', (await run('exit 2')).exitCode === 2);
    let unicode = await run('[Console]::OutputEncoding.CodePage');
    if (unicode.out.trim() === '65001') {
      unicode = await run('Write-Output 漢字');
      check('non-ASCII passthrough is UTF-8 ($PROFILE prerequisite met)', unicode.out.includes('漢字'));
    } else {
      // Non-ASCII passthrough depends on the deployed $PROFILE prerequisite, not on
      // this mod: without the profile line the child runs in the system OEM code
      // page while the mod itself stays verbatim-correct.
      check(`non-ASCII passthrough SKIPPED: $PROFILE UTF-8 prerequisite not deployed (code page ${unicode.out.trim()}); mod verbatim behavior unaffected`, true);
    }
    let timeoutMessage = ''; try { await Promise.race([run('Start-Sleep -Sec 30', { timeout: 1 }), new Promise((_, reject) => setTimeout(() => reject(new Error('test guard timeout')), 15000))]); } catch (e) { timeoutMessage = e.message; }
    check('timeout rejects with timeout:1', timeoutMessage.startsWith('timeout:1'));
    const ac = new AbortController(); const abortPromise = run('Start-Sleep -Sec 30', { signal: ac.signal }); setTimeout(() => ac.abort(), 300);
    let abortMessage = ''; try { await Promise.race([abortPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('test guard timeout')), 15000))]); } catch (e) { abortMessage = e.message; }
    check('abort rejects after aborting child tree', abortMessage === 'aborted');
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
    for (const label of ['spawn introspection: -NonInteractive kept, no -NoProfile/-ExecutionPolicy/prefix', 'native spawn introspection matches direct pwsh', 'exit code preserves PowerShell exit 2', 'non-ASCII passthrough is UTF-8 ($PROFILE prerequisite met)', 'timeout rejects with timeout:1', 'abort rejects after aborting child tree', 'host choice prompt fails fast under -NonInteractive', 'Get-Credential fails fast under -NonInteractive', 'Read-Host throws NonInteractive (no silent empty pass)']) check(`${label} (skip: no Windows pwsh)`, true);
  }
  // Transcode layer removal regression: this mod must stay a verbatim passthrough.
  // Encoding correction lives in $PROFILE ([console]::InputEncoding/OutputEncoding =
  // UTF8), so the source must contain no decoder/probe machinery and must document
  // the profile prerequisite.
  check('transcode layer removed from source', !/transcodeChunk|TextDecoder|probeOutputCodePage|codePageLabel/.test(src));
  check('profile UTF-8 prerequisite documented in source', src.includes('[console]::InputEncoding') && src.includes('$PROFILE'));
  check('-NonInteractive retention documented with hang evidence', /-NonInteractive is kept/.test(src) && /Get-Credential/.test(src));} catch (e) { check('test suite setup', false, String(e?.stack ?? e)); }
finally { rmSync(scratch, { recursive: true, force: true }); }
let failed = 0;
for (const c of checks) if (!c.ok) { failed++; console.error(`FAIL ${c.label}: ${c.detail}`); }
console.log(`${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exitCode = 1;
