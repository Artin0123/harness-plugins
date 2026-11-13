// Windows regression battery for env-guard. Run: node pi-agent/tests/env-guard/index.mjs
// Loads TypeScript directly from a throwaway copy, stubbing only pi's package API.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, '..', '..', 'env-guard', 'index.ts');
const scratch = mkdtempSync(join(tmpdir(), 'env-guard-pi-'));
const src = readFileSync(srcPath, 'utf8').replace(
  'import { getAgentDir, getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";',
  'const getAgentDir = () => process.env.EG_AGENT_DIR ?? "";\nconst getShellConfig = (p) => ({shell: p ?? process.env.EG_SHELL, args: ["-c"]});',
);
writeFileSync(join(scratch, 'index.ts'), src, 'utf8');
process.env.EG_AGENT_DIR = scratch;
const mod = await import(pathToFileURL(join(scratch, 'index.ts')).href);
const checks = [];
const check = (label, ok, detail = '') => checks.push({ label, ok: !!ok, detail });
// Local capture of what pi actually sees (bash emits GBK bytes; pi decodes as
// UTF-8, so invalid sequences arrive as U+FFFD replacement chars - captured live
// from `cmd //c ver` under NO_PATHCONV through a pi-shaped all-pipe spawn).
// Fingerprint = first TWO non-empty lines (ASCII prefixes of both survive any
// decoding); the trailing drive-prompt line is present with piped stdin, absent
// with stdin=/dev/null (both captured live) - it is NOT part of the fingerprint.
const bannerLine1 = 'Microsoft Windows [\uFFFD\u6C7E 10.0.19045.7725]';
const bannerLine2 = '(c) Microsoft Corporation\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\u0228\uFFFD\uFFFD\uFFFD\uFFFD';
const banner = [bannerLine1, bannerLine2, '', 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'agent>'].join('\r\n');
const bannerNoPrompt = [bannerLine1, bannerLine2, ''].join('\r\n'); // stdin=/dev/null shape, captured live

// Temp rewrite path suite. On non-Windows, behavior is intentionally inert.
const win = process.platform;
let temp, inputs;
try {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  temp = mod.realTempDir();
  inputs = [
    ['/tmp', 'path.tempMount', ''], ['/tmp/a/b', 'path.tempMount', '\\a\\b'], ['/TMP\\z', 'path.tempMount', '\\z'],
    ['$TEMP/a', 'path.tempVar', '\\a'], ['$TMP', 'path.tempVar', ''], ['$TMPDIR/a', 'path.tempVar', '\\a'],
    ['${TEMP}/a', 'path.tempVar', '\\a'], ['${TMPDIR}', 'path.tempVar', ''], ['%TEMP%/a', 'path.tempVar', '\\a'], ['%tmp%\\z', 'path.tempVar', '\\z'],
  ];
  for (const [input, kind, rest] of inputs) {
    const r = mod.rewritePathFix(input);
    check(`temp family ${input}`, !!temp && r.kind === kind && r.value.startsWith(temp) && r.value.slice(temp.length) === rest);
  }
  for (const input of ['/c/Users/x', 'C:\\tmp', '~/x', 'nul', '/tmp\\a/b']) {
    const r = mod.rewritePathFix(input);
    check(`deliberate boundary ${input}`, input === '/tmp\\a/b' ? r.value === temp + '\\a\\b' : r.value === input);
  }
} catch (e) { check('path suite setup', false, String(e)); }
finally { Object.defineProperty(process, 'platform', { value: win, configurable: true }); }

// Output classifier: actual ASCII prefix survives code-page-dependent banner text.
check('captured cmd banner (piped stdin)', mod.detectCmdBanner(banner));
check('captured cmd banner (stdin /dev/null)', mod.detectCmdBanner(bannerNoPrompt));
check('clean English banner', mod.detectCmdBanner('Microsoft Windows [Version 10.0]\n(c) Microsoft Corporation. All rights reserved.\n\nC:\\>'));
for (const [name, value] of [
  ['ordinary git output', 'commit abc\nAuthor: A\n'],
  ['prompt without banner', 'hello\nC:\\x>'],
  ['empty', ''],
  ['truncated first line', '...Microsoft Windows [Version]\n(c) Microsoft Corporation.'],
  ['ver normal output (single line, NO_PATHCONV)', bannerLine1],
  ['banner line without copyright line', 'Microsoft Windows [Version 10.0]\nC:\\>'],
  ['copyright line without banner line', '(c) Microsoft Corporation. All rights reserved.'],
]) check(name, !mod.detectCmdBanner(value));
check('pick hint with conversion disabled', mod.pickCmdHint(true).includes('cmd /c <command>'));
check('pick hint with conversion enabled', mod.pickCmdHint(false).includes('cmd //c <command>'));

// Real hook wiring with a fake pi API.
const handlers = {};
const pi = { on: (name, fn) => { handlers[name] = fn; }, getSettings: () => ({}) };
try { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }); mod.default(pi); }
catch (e) { check('register hooks', false, String(e)); }
check('hooks registered', !!handlers.tool_call && !!handlers.tool_result && !!handlers.before_agent_start);
const pathInput = { path: '/tmp/x' };
handlers.tool_call({ toolName: 'write', input: pathInput });
check('write path rewritten', !!temp && pathInput.path.startsWith(temp));

const runResult = (text, options = {}) => {
  const original = { type: 'text', text };
  const content = [original];
  const event = { toolName: 'bash', isError: options.isError ?? false,
    structuredContent: { exit_code: options.exit ?? 0 }, content };
  const patch = handlers.tool_result(event);
  return { event, original, content, patch };
};
const hit = runResult(banner);
check('banner advisory via patch', hit.patch?.content?.length === 2 && hit.patch.content[1].type === 'text' && hit.patch.content[1].text.includes('[env-guard]'));
check('structuredContent preserved in patch', hit.patch?.structuredContent?.exit_code === 0);
check('original event untouched', hit.event.content.length === 1 && hit.content[0] === hit.original && hit.original.text === banner);
const hitAgain = runResult(bannerNoPrompt);
check('each banner gets advisory', hitAgain.patch?.content?.length === 2);
check('error is ignored', !runResult(banner, { isError: true }).patch);
check('nonzero exit ignored', !runResult(banner, { exit: 1 }).patch);
check('ordinary successful output ignored', !runResult('git log\ncommit xyz').patch);
check('ver normal output ignored', !runResult(bannerLine1).patch);
const stats = JSON.parse(readFileSync(join(scratch, 'env-guard-stats.json'), 'utf8'));
check('cmdBanner stats increments', stats.fixes['shell.cmdBanner'] === 2, JSON.stringify(stats.fixes));

// System prompt behavior is direction-dependent on the real shell probe.
// Preferred channel: mutate systemPromptOptions.promptGuidelines in place (Pi
// diffs prompt sections, so the hint reaches the model cache-friendlily).
// Fallback channel: return a systemPrompt patch (hosts without structured options).
let gate = false;
try { gate = mod.pathConvDisabled(); } catch { /* fail-safe */ }
for (let n = 0; n < 2; n++) {
  const guidelines = [];
  const ev = { systemPrompt: 'base prompt', systemPromptOptions: { promptGuidelines: guidelines } };
  handlers.before_agent_start(ev);
  if (gate) check(`system hint via options, run ${n + 1}`, guidelines.length === 1 && guidelines[0].includes('[env-guard:windows-paths]'));
  else check(`system hint gated off, run ${n + 1}`, guidelines.length === 0);
  if (gate) {
    const twice = { systemPrompt: 'base prompt', systemPromptOptions: { promptGuidelines: [...guidelines] } };
    handlers.before_agent_start(twice);
    check(`system hint not duplicated within chain, run ${n + 1}`, twice.systemPromptOptions.promptGuidelines.length === 1);
  }
  // Fallback path: no structured options -> returned patch.
  const ev2 = { systemPrompt: 'base prompt' };
  const patch = handlers.before_agent_start(ev2);
  if (gate) {
    check(`system hint via patch, run ${n + 1}`, typeof patch?.systemPrompt === 'string' && patch.systemPrompt.includes('[env-guard:windows-paths]'));
    const twice2 = { systemPrompt: patch.systemPrompt };
    check(`system patch idempotent, run ${n + 1}`, handlers.before_agent_start(twice2) === undefined);
  } else {
    check(`system patch gated off, run ${n + 1}`, patch === undefined && !ev2.systemPrompt.includes('[env-guard:windows-paths]'));
  }
}

// Direction 2: gate=on (a probed MSYS shell that sees MSYS_NO_PATHCONV, e.g.
// via BASH_ENV-sourced bashrc). Fresh module instance with EG_SHELL pointing at
// the real MSYS bash; cache-busting query gives it a fresh probe cache.
if (process.platform === 'win32') {
  const { spawnSync } = await import('node:child_process');
  const b = spawnSync('bash', ['-c', 'cygpath -w /usr/bin/bash'], { encoding: 'utf8' });
  const bashPath = (b.stdout || '').trim();
  if (b.status === 0 && /^[A-Za-z]:/.test(bashPath)) {
    process.env.EG_SHELL = bashPath;
    const mod2 = await import(pathToFileURL(join(scratch, 'index.ts')).href + '?gate-on');
    const handlers2 = {};
    mod2.default({ on: (n, f) => { handlers2[n] = f; }, getSettings: () => ({}) });
    check('gate-on probe', mod2.pathConvDisabled() === true);
    const guidelines = [];
    handlers2.before_agent_start({ systemPrompt: 'base', systemPromptOptions: { promptGuidelines: guidelines } });
    check('system hint via options (gate on)', guidelines.length === 1 && guidelines[0].includes('[env-guard:windows-paths]'));
    const twice = { systemPrompt: 'base', systemPromptOptions: { promptGuidelines: [...guidelines] } };
    handlers2.before_agent_start(twice);
    check('system hint not duplicated (gate on)', twice.systemPromptOptions.promptGuidelines.length === 1);
    const p2 = handlers2.before_agent_start({ systemPrompt: 'base' });
    check('system hint via patch (gate on)', typeof p2?.systemPrompt === 'string' && p2.systemPrompt.includes('[env-guard:windows-paths]'));
    check('system patch idempotent (gate on)', handlers2.before_agent_start({ systemPrompt: p2.systemPrompt }) === undefined);
    const ev3 = { toolName: 'bash', isError: false, structuredContent: { exit_code: 0 }, content: [{ type: 'text', text: banner }] };
    const patch3 = handlers2.tool_result(ev3);
    check('advisory says cmd /c when NOCONV (gate on)', patch3?.content?.[1]?.text.includes('cmd /c <command>') === true);
    delete process.env.EG_SHELL;
  } else {
    check('gate-on section skipped (no MSYS bash found)', true);
  }
}

const failed = checks.filter(x => !x.ok);
for (const c of checks) if (!c.ok) console.error(`FAIL ${c.label}: ${c.detail}`);
console.log(`${checks.length - failed.length}/${checks.length} checks passed (pathConvDisabled=${gate})`);
try { rmSync(scratch, { recursive: true, force: true }); } catch {}
if (failed.length) process.exitCode = 1;
