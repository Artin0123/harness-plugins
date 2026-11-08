// native-powershell — restore native PowerShell spawning for pi.
// Failure point: the host hardcodes POWERSHELL_ARGS (-NoProfile, -NonInteractive,
// -ExecutionPolicy Bypass) and prepends a UTF-8 command, so introspection such as
// (Get-Process -Id $PID).CommandLine sees injected arguments and command text.
// Fix: override the built-in powershell tool by name and spawn exactly
// {pwsh} -Command <command>, preserving the command verbatim with no extra args
// or prefix. No encoding rewrite in-code: pi's capture layer decodes pipe bytes as
// UTF-8, so output from a shell reporting a non-65001 code page would arrive garbled.
// The single repair point is $PROFILE: every machine running this mod MUST deploy
//   [console]::InputEncoding = [console]::OutputEncoding = [System.Text.Encoding]::UTF8
// in its PowerShell profile — for both pwsh 7 (Documents\PowerShell\) and Windows
// PowerShell 5.1 (Documents\WindowsPowerShell\). On headless spawns without a
// console, the code page falls back to the system OEM page, so this cannot be relied
// on from inherited console state alone; the profile line is the authoritative fix.
// Without it the output decodes as mojibake; that is a known, accepted gap — the
// in-code transcode layer was deliberately removed to keep this mod a verbatim
// passthrough.

import { createPowerShellTool, getPowerShellConfig } from "@earendil-works/pi-coding-agent";
import { access as fsAccess } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { constants as osConstants } from "node:os";

const shellPath = (() => { try { return getPowerShellConfig().shell; } catch { return null; } })();

function killTree(pid: number | undefined): void {
  if (!pid) return;
  const exe = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\taskkill.exe` : "taskkill.exe";
  try { const child = spawn(exe, ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); child.once("error", () => {}); } catch { /* best-effort tree kill */ }
}

export function createNativePowerShellOperations(shell: string) {
  return { async exec(command: string, cwd: string, options: { onData?: (data: Buffer | string) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }) {
    try { await fsAccess(cwd, fsConstants.F_OK); } catch { throw new Error(`Working directory does not exist: ${cwd}`); }
    const { onData, signal, timeout, env } = options;
    if (signal?.aborted) throw new Error("aborted");
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error(`Invalid timeout: ${timeout}`);
    return await new Promise<{ exitCode: number }>((resolve, reject) => {
      let child;
      try { child = spawn(shell, ["-Command", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
      catch (e) { reject(e); return; }
      const streams = [child.stdout, child.stderr];
      streams.forEach(stream => stream.on("data", (b: Buffer) => onData?.(b)));
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const cleanup = () => { signal?.removeEventListener("abort", abort); if (timer) clearTimeout(timer); };
      const fail = (message: string) => { if (settled) return; settled = true; killTree(child.pid); cleanup(); reject(new Error(message)); };
      const abort = () => fail("aborted");
      signal?.addEventListener("abort", abort, { once: true });
      if (timeout !== undefined) timer = setTimeout(() => fail(`timeout:${timeout}`), timeout * 1000);
      child.once("error", (e: Error) => { if (!settled) { settled = true; cleanup(); reject(e); } });
      child.once("close", (exitCode: number | null, signalCode: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) });
      });
    });
  } };
}

export default function (pi: any): void {
  if (!shellPath) return;
  pi.registerTool(createPowerShellTool(process.cwd(), { operations: createNativePowerShellOperations(shellPath) }));
}
