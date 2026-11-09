// pwsh-profile-shim — OpenCode v2 plugin.
//
// Problem (v2.2.6 binary, verified 2026-11-09): the shell tool hardcodes the
// argument vector ["-NoLogo","-NoProfile","-NonInteractive","-Command",cmd]
// (Pae(); meta table O1 marks only powershell/pwsh as "ps"), so the user's
// PowerShell profile never loads. The meta table is a literal with no config
// override, and scanning (ShellTool.prepare -> K2()) runs against the tool
// input BEFORE this hook, so rename tricks cannot help.
//
// Fix, minimal-deviation form (docs/archive/PLAN.md section 3, variant B): keep every
// injected argument, drop only -NoProfile through a small shim exe:
//
//   shell.create.before:  event.env.OCPWSH_PATH = event.shell
//                         event.shell = <LOCALAPPDATA>\opencode\pwshshim\pwsh.exe
//
// The shim basename still reads "pwsh", so the scanner keeps PowerShell mode
// and permission resources stay computed from the original command. The real
// shell becomes a direct child of the shim, and opencode kills spawns with
// "taskkill /pid <shim> /T /F" (win32 branch in the spawner), so timeouts and
// aborts still remove the whole tree.
//
// Packaging discipline mirrors chat-trim-context: no runtime dependency on
// @opencode/plugin (define is identity), no npm dependencies, single dir =
// index.ts + shim-src.cs (the source this file embeds; tests pin equality).
//
// Inert conditions (never guess a fix): non-win32, LOCALAPPDATA or windir
// missing, in-box csc missing, ctx.shell hook contract absent, compile
// failure. In those cases the plugin logs to stderr and registers nothing.
const define = <T>(plugin: T): T => plugin

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SHIM_VERSION = "1.0.0";
const SHIM_DIR_NAME = join("opencode", "pwshshim");
const SHIM_EXE_NAME = "pwsh.exe";
const WARN_PREFIX = "[pwsh-profile-shim] ";
const warn = (message: string) => console.error(WARN_PREFIX + message);

// In-box compiler location, constant on Windows 10+ (verified on this machine).
const CSC_RELATIVE = join("Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");

// Embedded copy of shim-src.cs, byte-identical (oc-plugins/tests/shim pins it).
// The C# source deliberately contains no backslash literals, no backticks and
// no dollar-brace sequences, so this template literal needs no escaping.
const SHIM_CS = `// shim-src.cs — compiled by the plugin (oc-plugins/pwsh-profile-shim/index.ts) at
// first setup with the in-box compiler C:\Windows\Microsoft.NET\Framework64\
// v4.0.30319\csc.exe, then spawned by opencode in place of the real pwsh.
//
// Contract (docs/archive/PLAN.md section 3, variant B):
//   * forward every argument verbatim, order preserved
//   * drop the injected "-NoProfile" token only when the whole token equals it
//     (case-insensitive); "-NoProfileX" and friends are forwarded as-is
//   * re-quote per the standard Windows argv rules (backslash/quote pairing)
//   * target = env OCPWSH_PATH (set by the plugin hook); when the variable is
//     missing (manual runs / tests) fall back to "pwsh.exe" via PATH search
//   * exit code passthrough; opencode kills this shim with the win32 spawner
//     branch "taskkill /pid <shim> /T /F", and the real shell is a direct
//     child, so the whole tree dies without any job-object work
//
// Style note: this file deliberately contains zero backslash literals. The
// in-box compiler is C# 5 (no newer syntax), and the absence of backslashes
// lets index.ts embed this source verbatim inside a JavaScript template
// literal with no escaping ambiguity. The packaging tests pin the embedded
// copy and this file to byte equality.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;

class Shim
{
    static int Main(string[] args)
    {
        string target = Environment.GetEnvironmentVariable("OCPWSH_PATH");
        if (target == null || target.Length == 0)
        {
            target = "pwsh.exe";
        }

        var argv = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], "-NoProfile", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            if (argv.Length > 0)
            {
                argv.Append(' ');
            }
            argv.Append(Quote(args[i]));
        }

        var psi = new ProcessStartInfo();
        psi.UseShellExecute = false;
        psi.FileName = target;
        psi.Arguments = argv.ToString();

        Process process;
        try
        {
            process = Process.Start(psi);
        }
        catch (Exception error)
        {
            // Launch failure (missing target, permission): report loudly instead
            // of pretending the user command ran.
            Console.Error.Write("pwsh-profile-shim: cannot spawn target: ");
            Console.Error.WriteLine(error.Message);
            return 1;
        }

        process.WaitForExit();
        return process.ExitCode;
    }

    // Standard Windows word quoting. arg becomes bare when it contains none of
    // the characters that force re-quoting; otherwise backslashes and quotes
    // are escaped per the Microsoft command-line rules and the result is
    // wrapped in double quotes.
    static string Quote(string arg)
    {
        char backslash = (char)92;
        char quote = (char)34;
        char tab = (char)9;
        char lf = (char)10;
        char cr = (char)13;

        if (arg.Length > 0 && arg.IndexOf(' ') < 0 && arg.IndexOf(tab) < 0
            && arg.IndexOf(quote) < 0 && arg.IndexOf(lf) < 0 && arg.IndexOf(cr) < 0)
        {
            return arg;
        }

        int pending = 0;
        var result = new StringBuilder(arg.Length + 2);
        result.Append(quote);
        for (int i = 0; i < arg.Length; i++)
        {
            char c = arg[i];
            if (c == backslash)
            {
                pending++;
                continue;
            }
            if (c == quote)
            {
                result.Append(backslash, pending * 2 + 1);
                pending = 0;
            }
            else
            {
                result.Append(backslash, pending);
                pending = 0;
            }
            result.Append(c);
        }
        result.Append(backslash, pending * 2);
        result.Append(quote);
        return result.ToString();
    }
}
`;

export default define({
  id: "pwsh.profile-shim",
  async setup(ctx: any) {
    if (process.platform !== "win32") return;
    const baseDir = process.env.LOCALAPPDATA;
    const windir = process.env.windir;
    if (typeof baseDir !== "string" || typeof windir !== "string") return;

    const shimExe = join(join(baseDir, SHIM_DIR_NAME), SHIM_EXE_NAME);
    const versionFile = join(join(baseDir, SHIM_DIR_NAME), "shim-version.txt");
    const cscPath = join(windir, CSC_RELATIVE);
    if (!existsSync(cscPath)) {
      warn("in-box compiler not found (" + cscPath + "), staying inert");
      return;
    }

    try {
      mkdirSync(join(baseDir, SHIM_DIR_NAME), { recursive: true });
      const version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : "";
      if (version !== SHIM_VERSION || !existsSync(shimExe)) {
        compileShim(join(baseDir, SHIM_DIR_NAME), shimExe, cscPath);
        writeFileSync(versionFile, SHIM_VERSION + "\n", "utf8");
      }
    } catch (error) {
      warn("shim deployment failed, staying inert: " + String(error));
      return;
    }

    try {
      await ctx.shell.hook("create.before", (event: any) => {
        const shell: string = typeof event?.shell === "string" ? event.shell : "";
        const separator = Math.max(shell.lastIndexOf("\\"), shell.lastIndexOf("/"));
        if (separator < 0) return;
        const base = shell.slice(separator + 1).toLowerCase();
        if (base !== "pwsh.exe" && base !== "powershell.exe") return;
        event.env.OCPWSH_PATH = shell;
        event.shell = shimExe;
      });
    } catch (error) {
      warn("shell hook contract unavailable, staying inert: " + String(error));
    }
  },
})

function compileShim(shimDir: string, shimExe: string, cscPath: string) {
  const stamp = String(process.pid) + "-" + String(Date.now());
  const csPath = join(shimDir, ".shim-src-" + stamp + ".cs");
  const outPath = join(shimDir, ".shim-" + stamp + ".exe");
  writeFileSync(csPath, SHIM_CS, "utf8");
  try {
    const result = spawnSync(cscPath, ["/nologo", "/target:exe", "/out:" + outPath, csPath], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.status !== 0 || !existsSync(outPath)) {
      throw new Error(
        "csc exit " + String(result.status) + ": " + String(result.stdout ?? "") + String(result.stderr ?? ""),
      );
    }
    renameSync(outPath, shimExe);
  } finally {
    rmSync(csPath, { force: true });
    rmSync(outPath, { force: true });
  }
}
