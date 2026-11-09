// pwsh-profile-loader — OpenCode v2 plugin.
//
// Problem (v2.2.6 binary, verified 2026-11-09): the shell tool hardcodes the
// argument vector ["-NoLogo","-NoProfile","-NonInteractive","-Command",cmd]
// (Pae(); meta table O1), so the user's PowerShell profile never loads.
//
// Mechanism: prefix the command with a profile dot-source chain that mirrors
// PowerShell's native four-file order (AllUsersAllHosts, AllUsersCurrentHost,
// CurrentUserAllHosts, CurrentUserCurrentHost), each guarded so a missing
// profile is fully inert and a failing one is reported on stderr (native
// prints and continues; the catch keeps that "never abort the command" rule):
//
//   try{if([IO.File]::Exists($PROFILE.AllUsersAllHosts)){. $PROFILE.AllUsersAllHosts}}catch{...};...$PROFILE...
//
// Why mutation is safe (binary proof, v2.2.6): the spawner builds the real
// spawn call as Pae(PH.shell, PH.command) only AFTER
// trigger("shell","create.before",PH), so every hook mutation of event.command
// is what actually reaches the spawned argv. Scanning/permissions
// (ShellTool.prepare -> K2()) ran BEFORE this hook on the tool's original
// input and are not affected — the only semantic surface added is loading the
// user's own profiles, which is exactly what -NoProfile removal would load.
//
// Cost accounting (measured 2026-11-09): 4-file chain vs 1-file prefix = +3
// ms/call (median-of-9, same batch, 299 vs 302 ms) — the 3 extra Exists guards
// are BCL calls, no cmdlet module autoload. All-ASCII prefix, no transcoding
// surface. $PROFILE is populated even under -NoProfile (verified).
const define = <T>(plugin: T): T => plugin

// Failures are re-emitted as the ORIGINAL ErrorRecord through pwsh's native
// error formatting engine (Write-Error -ErrorRecord): the display is the native
// error view itself (file : message, At line/char, CategoryInfo,
// FullyQualifiedErrorId) — no invented format, no marker text. EAP is saved,
// forced to Continue only for the report, then restored, so a profile that set
// EAP=Stop before failing cannot abort the remaining chain (native loader also
// tolerates profile errors). 5.1-safe syntax.
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
