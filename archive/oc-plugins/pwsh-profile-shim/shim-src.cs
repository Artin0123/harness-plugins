// shim-src.cs — compiled by the plugin (oc-plugins/pwsh-profile-shim/index.ts) at
// first setup with the in-box compiler C:\Windows\Microsoft.NET\Framework64\
// v4.0.30319\csc.exe, then spawned by opencode in place of the real pwsh.
//
// Contract (docs/PLAN.md section 3, variant B):
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
