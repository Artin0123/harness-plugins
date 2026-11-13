// native-powershell — registers the host's powershell tool under the same name, so that
// PowerShell starts without -NoProfile and without -ExecutionPolicy Bypass. Those two
// flags are the only difference from the host; the command prefix, the validation, the
// settlement rule and the tree kill are the host's own behaviour.
//
// Where each part lives:
//   startArguments()      removes the two flags from the host's argument list
//   UTF8_OUTPUT_PREFIX    the host's command prefix, copied verbatim
//   killProcessTree()     the host's tree kill (taskkill /F /T)
//   exec()                validation, spawn, settlement, cleanup
//   default export        registers the tool through the host's own factory
//
// The comments below explain what each part does and why it is written this way. Why
// exactly these two flags are dropped, why the UTF-8 prefix stays, what still differs
// from the host: docs/spec.md section 1. Why -NonInteractive stays: without the flag a
// command that asks for input (Get-Credential, Read-Host) opens a desktop dialog and
// the tool call hangs until something outside kills it.

import { createPowerShellTool, getPowerShellConfig } from "@earendil-works/pi-coding-agent";
import { access as fsAccess } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { constants as osConstants } from "node:os";

// Bounds taken from the host exec engine; a timeout beyond these overflows setTimeout.
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const EXIT_STDIO_GRACE_MS = 100;

// Verbatim copy of UTF8_OUTPUT_PREFIX in dist/core/tools/powershell.js, which the host
// keeps private. The prefix sets the console output encoding, and a headless pwsh
// console otherwise uses the system code page, so every non-ASCII output would arrive
// mojibake'd. The test suite checks the resulting code page rather than this string.
const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

// The two flags this extension removes from POWERSHELL_ARGS.
const DROPPED_FLAG = "-NoProfile";
const DROPPED_FLAG_WITH_VALUE = "-ExecutionPolicy";

/**
 * The host's argument list with the two dropped flags removed.
 *
 * Everything else in the list is passed through unchanged, so a flag added or
 * removed upstream does not have to be mirrored here. `-ExecutionPolicy` takes a
 * value, and the value has to be dropped together with the flag.
 */
export function startArguments(hostArgs: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < hostArgs.length; index += 1) {
    const argument = hostArgs[index];
    if (argument === DROPPED_FLAG) continue;
    if (argument === DROPPED_FLAG_WITH_VALUE) {
      index += 1;
      continue;
    }
    kept.push(argument);
  }
  return kept;
}

/** Same behaviour as killProcessTree in dist/utils/shell.js on Windows. */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  const exe = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\taskkill.exe`;
  try {
    const child = spawn(exe, ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore", detached: true, windowsHide: true,
    });
    child.once("error", () => {});
  } catch { /* best-effort tree kill */ }
}

export function createNativePowerShellOperations() {
  return {
    async exec(
      command: string,
      cwd: string,
      options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
    ) {
      const { onData, signal, timeout, env } = options;
      // Validation order and messages are the host's: timeout, then abort, then cwd.
      if (timeout !== undefined) {
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new Error("Invalid timeout: must be a finite number of seconds");
        }
        if (timeout * 1000 > MAX_TIMEOUT_MS) {
          throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
        }
      }
      if (signal?.aborted) throw new Error("aborted");
      try {
        await fsAccess(cwd, fsConstants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`);
      }
      // Resolved per call, like the host: a missing executable then surfaces from exec
      // with the host's message instead of being frozen at load time.
      const shell = getPowerShellConfig();
      return await new Promise<{ exitCode: number }>((resolve, reject) => {
        const child = spawn(shell.shell, [...startArguments(shell.args), UTF8_OUTPUT_PREFIX + command], {
          cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
        const streams = [child.stdout, child.stderr];
        let timer: NodeJS.Timeout | undefined;
        let grace: NodeJS.Timeout | undefined;
        let settled = false;
        let exited = false;
        let ended = 0;
        let timedOut = false;
        let exitCode: number | null = null;
        let signalCode: NodeJS.Signals | null = null;
        const cleanup = () => {
          signal?.removeEventListener("abort", onAbort);
          if (timer) clearTimeout(timer);
          if (grace) clearTimeout(grace);
        };
        // Like the host: kill the tree first, report only once the shell is gone, so a
        // caller never sees the promise settle while the old process tree is still alive.
        const onAbort = () => killProcessTree(child.pid);
        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          child.stdout?.destroy();
          child.stderr?.destroy();
          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
            return;
          }
          resolve({ exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) });
        };
        // Settle on exit, not on close: a background descendant inheriting our stdio
        // keeps the pipes open, and waiting for close would stall the tool call.
        const armGrace = () => {
          if (grace) clearTimeout(grace);
          grace = setTimeout(finish, EXIT_STDIO_GRACE_MS);
        };
        streams.forEach(stream => {
          stream.on("data", (chunk: Buffer) => { onData(chunk); if (exited && !settled) armGrace(); });
          stream.once("end", () => { ended += 1; if (exited && ended === streams.length) finish(); });
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (timeout !== undefined) {
          timer = setTimeout(() => { timedOut = true; killProcessTree(child.pid); }, timeout * 1000);
        }
        child.once("error", (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
        child.once("exit", (code: number | null, sig: NodeJS.Signals | null) => {
          exited = true;
          exitCode = code;
          signalCode = sig;
          if (ended === streams.length) finish(); else armGrace();
        });
        child.once("close", () => finish());
      });
    }
  };
}

export default function (pi: any): void {
  // Same name as the built-in tool, so registering this one replaces it.
  pi.registerTool(createPowerShellTool(process.cwd(), { operations: createNativePowerShellOperations() }));
}
