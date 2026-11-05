// native-powershell — restore native PowerShell spawning for pi.
// Failure point: the host hardcodes POWERSHELL_ARGS (-NoProfile, -NonInteractive,
// -ExecutionPolicy Bypass) and prepends a UTF-8 command, so introspection such as
// (Get-Process -Id $PID).CommandLine sees injected arguments and command text.
// Fix: override the built-in powershell tool by name and spawn exactly
// {pwsh} -Command <command>, preserving the command verbatim with no extra args
// or prefix. Boundary-only encoding repair: pi's capture layer decodes pipe bytes as
// UTF-8; when the spawned pwsh declares a non-65001 output code page (e.g. Windows
// PowerShell 5.1 OEM), decoded text is re-encoded to UTF-8 bytes before forwarding —
// repairing only the transcoding boundary, not command semantics. If probing fails,
// passthrough; never guess.

import { createPowerShellTool, getPowerShellConfig } from "@earendil-works/pi-coding-agent";
import { access as fsAccess } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { constants as osConstants } from "node:os";

const shellPath = (() => { try { return getPowerShellConfig().shell; } catch { return null; } })();
const labels: Record<number, string> = { 437: "ibm437", 850: "ibm850", 852: "ibm852", 866: "ibm866", 932: "shift_jis", 936: "gb18030", 950: "big5", 1250: "windows-1250", 1251: "windows-1251", 1252: "windows-1252", 1253: "windows-1253", 1254: "windows-1254", 1255: "windows-1255", 1256: "windows-1256", 1257: "windows-1257", 1258: "windows-1258" };
export function codePageLabel(codePage: number): string | null { return labels[codePage] ?? null; }

function runProbe(shell: string): Promise<number | null> {
  return new Promise(resolve => {
    let child;
    try { child = spawn(shell, ["-Command", "[Console]::OutputEncoding.CodePage"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); }
    catch { resolve(null); return; }
    let output = "";
    child.stdout.on("data", (b: Buffer) => { output += b.toString("utf8"); });
    child.once("error", () => resolve(null));
    child.once("close", code => { const n = Number(output.trim()); resolve(code === 0 && Number.isFinite(n) && Number.isInteger(n) ? n : null); });
  });
}
const probeCache = new Map<string, Promise<number | null>>();
export function probeOutputCodePage(shell: string): Promise<number | null> {
  if (!probeCache.has(shell)) probeCache.set(shell, runProbe(shell));
  return probeCache.get(shell)!;
}

// Decode a captured chunk, then re-encode as UTF-8: pi's OutputAccumulator owns its
// own UTF-8 decoder and only accepts BufferSource (a raw string throws TypeError),
// so the boundary fix must deliver the child's declared encoding as UTF-8 bytes.
export function transcodeChunk(decoders: TextDecoder[] | null, index: number, data: Buffer | string, isTail = false): Buffer {
  const decoder = decoders?.[index];
  const text = isTail && decoder ? decoder.decode() : decoder ? decoder.decode(data, { stream: true }) : data;
  return Buffer.from(text as string, "utf8");
}

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
    const cp = await probeOutputCodePage(shell);
    let label: string | null = null;
    if (cp !== null && cp !== 65001) { const candidate = codePageLabel(cp); if (candidate) { try { new TextDecoder(candidate); label = candidate; } catch { label = null; } } }
    return await new Promise<{ exitCode: number }>((resolve, reject) => {
      let child;
      try { child = spawn(shell, ["-Command", command], { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
      catch (e) { reject(e); return; }
      const decoders = label ? [new TextDecoder(label), new TextDecoder(label)] : null;
      const streams = [child.stdout, child.stderr];
      streams.forEach((stream, i) => stream.on("data", (b: Buffer) => onData?.(transcodeChunk(decoders, i, b))));
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
        if (decoders) for (let i = 0; i < decoders.length; i++) { const tail = decoders[i]!.decode(); if (tail) onData?.(transcodeChunk(decoders, i, tail, true)); }
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
