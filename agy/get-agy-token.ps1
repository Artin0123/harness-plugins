# get-agy-token.ps1 - fetch a FRESH Antigravity / Gemini access token.
#
# Why: ~/.gemini/oauth_creds.json is an orphan file that nothing refreshes.
# The credential agy actually uses lives in Windows Credential Manager
# (target = gemini:antigravity) and is only refreshed when a request that
# needs authentication is actually made. Local-only commands such as
# "agy plugin list" never touch the network, so nothing is refreshed.
#
# Usage:
#   .\get-agy-token.ps1             # refresh, print token, copy to clipboard
#   .\get-agy-token.ps1 -Masked     # verify readability without printing it
#   .\get-agy-token.ps1 -NoRefresh  # just read the current credential
param(
  [switch]$Masked,
  [switch]$NoRefresh
)

$ErrorActionPreference = 'Stop'
$agy = Join-Path $env:USERPROFILE '.gemini\bin\agy.exe'

if (-not $NoRefresh) {
  if (-not (Test-Path $agy)) { throw "agy.exe not found: $agy" }
  Write-Host 'Triggering a refresh (agy models makes one authenticated request)...'
  $out = Join-Path $env:TEMP 'agy-token.out'
  $err = Join-Path $env:TEMP 'agy-token.err'
  $p = Start-Process -FilePath $agy -ArgumentList 'models' -PassThru -WindowStyle Hidden `
       -RedirectStandardOutput $out -RedirectStandardError $err
  if (-not $p.WaitForExit(90000)) { $p.Kill(); throw 'agy models timed out' }
  if ($p.ExitCode -ne 0) {
    # Informational only: agy can exit non-zero here and still have refreshed.
    Write-Host ('agy models exited with ' + $p.ExitCode + '; using the stored credential regardless.') -ForegroundColor DarkGray
  }
}

$sig = @'
using System;
using System.Runtime.InteropServices;
public class AgyCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) throw new Exception("CredRead failed, error " + Marshal.GetLastWin32Error());
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return System.Text.Encoding.UTF8.GetString(b);
    } finally { CredFree(p); }
  }
}
'@
if (-not ('AgyCred' -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }

$json = [AgyCred]::Read('gemini:antigravity') | ConvertFrom-Json
$tok = $json.token.access_token
if (-not $tok) { throw 'no token.access_token in the credential blob' }

$exp = $null
if ($json.token.expiry) { $exp = [datetime]::Parse($json.token.expiry).ToLocalTime() }

Write-Host ''
Write-Host ("account   : " + $json.id_token_email)
Write-Host ("length    : " + $tok.Length + " chars")
if ($exp) {
  $left = [int]($exp - (Get-Date)).TotalMinutes
  Write-Host ("expires   : " + $exp.ToString('yyyy-MM-dd HH:mm:ss') + "  (" + $left + " minutes left)")
}
Write-Host ''

if ($Masked) {
  Write-Host ("prefix    : " + $tok.Substring(0, 10) + "... (masked)")
} else {
  Write-Host '--- access_token (paste into the manual token field) ---' -ForegroundColor Cyan
  Write-Host $tok
  try { Set-Clipboard -Value $tok; Write-Host '(copied to clipboard)' -ForegroundColor Green } catch {}
  Write-Host ''
  Write-Host 'Note: this is an OAuth access token, valid about 1 hour and held in page memory only; re-paste after a reload.' -ForegroundColor Yellow
}
