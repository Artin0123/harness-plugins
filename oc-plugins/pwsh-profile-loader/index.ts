// pwsh-profile-loader — OpenCode v2 plugin.
//
// Problem (v2.2.6 binary): the shell tool hardcodes the argument vector
// ["-NoLogo","-NoProfile","-NonInteractive","-Command",cmd], so the user's
// PowerShell profile never loads. The fix prefixes event.command (in
// shell.create.before) with a four-file profile chain; the mutation is safe
// because the spawner reads event.command only AFTER the hook (binary
// evidence, v2.2.6). Mechanism, error behavior and cost: docs/spec.md §3;
// decision & measurement log (binary symbols, timings): docs/archive/PLAN.md §9.
const define = <T>(plugin: T): T => plugin

// The snippet must also run under Windows PowerShell 5.1 (the hook matches
// powershell.exe too), so only 5.1-safe syntax here.
const warnInCatch =
  "catch{$o=$ErrorActionPreference;$ErrorActionPreference='Continue';Write-Error -ErrorRecord $_;$ErrorActionPreference=$o;}";
const loadOne = "try{if([IO.File]::Exists(%HOMEFILE%)){. %HOMEFILE%}}" + warnInCatch + ";";
const PROFILE_SNIPPET = [
  "$PROFILE.AllUsersAllHosts",
  "$PROFILE.AllUsersCurrentHost",
  "$PROFILE.CurrentUserAllHosts",
  "$PROFILE",
].map((name) => loadOne.split("%HOMEFILE%").join(name)).join("");

export default define({
  id: "pwsh.profile-loader",
  async setup(ctx: any) {
    if (typeof ctx?.shell?.hook !== "function") return; // inert if the hook surface is absent (never guess)
    await ctx.shell.hook("create.before", (event: any) => {
      const shell: string = typeof event?.shell === "string" ? event.shell : "";
      const separator = Math.max(shell.lastIndexOf("\\"), shell.lastIndexOf("/"));
      if (separator < 0) return;
      const base = shell.slice(separator + 1).toLowerCase();
      if (base !== "pwsh.exe" && base !== "powershell.exe") return;
      if (typeof event.command !== "string" || event.command.length === 0) return;
      if (event.command.startsWith(PROFILE_SNIPPET)) return; // idempotent re-entry
      event.command = PROFILE_SNIPPET + event.command;
    });
  },
})
