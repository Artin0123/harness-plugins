# get-agy-token.ps1 - fetch a FRESH Antigravity / Gemini access token to clipboard.
$ErrorActionPreference = 'Stop'

# 1. 定位 agy.exe
$agy = "$env:LOCALAPPDATA\agy\bin\agy.exe"
if (-not (Test-Path $agy)) {
  $fallbackAgy = Join-Path $env:USERPROFILE '.gemini\bin\agy.exe'
  if (Test-Path $fallbackAgy) { $agy = $fallbackAgy } else { throw "agy.exe not found: $agy" }
}

# 2. 觸發刷新 (透過 agy models 執行一次認證請求)
Write-Host 'Triggering a refresh (agy models makes one authenticated request)...' -ForegroundColor Cyan
$out = Join-Path $env:TEMP 'agy-token.out'
$err = Join-Path $env:TEMP 'agy-token.err'
$p = Start-Process -FilePath $agy -ArgumentList 'models' -PassThru -WindowStyle Hidden `
     -RedirectStandardOutput $out -RedirectStandardError $err
if (-not $p.WaitForExit(90000)) { $p.Kill(); throw 'agy models timed out' }

# 3. 註冊 Windows 憑證讀取 C# 結構
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
    if (!CredReadW(target, 1, 0, out p)) return null;
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

# 4. 雙來源讀取 (Windows 憑證庫 + SSH 檔案備援)
$candidates = @()

$tokenFile = Join-Path $env:USERPROFILE '.gemini\antigravity-cli\antigravity-oauth-token'
if (Test-Path $tokenFile) {
  try {
    $content = Get-Content -Raw -Path $tokenFile -ErrorAction SilentlyContinue
    if ($content) {
      $parsed = $content | ConvertFrom-Json
      if ($parsed.token.access_token) {
        $expVal = [datetime]::MinValue
        if ($parsed.token.expiry) { try { $expVal = [datetime]::Parse($parsed.token.expiry).ToLocalTime() } catch {} }
        $candidates += [PSCustomObject]@{ Json = $parsed; Expiry = $expVal }
      }
    }
  } catch {}
}

try {
  $rawCred = [AgyCred]::Read('gemini:antigravity')
  if ($rawCred) {
    $parsed = $rawCred | ConvertFrom-Json
    if ($parsed.token.access_token) {
      $expVal = [datetime]::MinValue
      if ($parsed.token.expiry) { try { $expVal = [datetime]::Parse($parsed.token.expiry).ToLocalTime() } catch {} }
      $candidates += [PSCustomObject]@{ Json = $parsed; Expiry = $expVal }
    }
  }
} catch {}

if ($candidates.Count -eq 0) {
  throw 'no token found in Credential Manager or local token file'
}

$best = $candidates | Sort-Object Expiry -Descending | Select-Object -First 1
$json = $best.Json
$tok = $json.token.access_token
if (-not $tok) { throw 'no token.access_token in credential' }

$exp = if ($best.Expiry -ne [datetime]::MinValue) { $best.Expiry } else { $null }

# 5. 複製到剪貼簿並輸出摘要 (不印出 Token 本身)
try {
  Set-Clipboard -Value $tok
  $copied = $true
} catch {
  $copied = $false
}

Write-Host ''
Write-Host ("account   : " + $json.id_token_email)
Write-Host ("length    : " + $tok.Length + " chars")
if ($exp) {
  $left = [int]($exp - (Get-Date)).TotalMinutes
  Write-Host ("expires   : " + $exp.ToString('yyyy-MM-dd HH:mm:ss') + "  (" + $left + " minutes left)")
}

if ($copied) {
  Write-Host '✅ access_token 已成功複製到剪貼簿！' -ForegroundColor Green
} else {
  Write-Host '⚠️ 無法存取剪貼簿，Token 字串如下：' -ForegroundColor Yellow
  Write-Host $tok
}
