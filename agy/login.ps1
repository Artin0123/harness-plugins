# Antigravity CLI SSH Login Helper
$logDir = Join-Path $env:USERPROFILE '.gemini\antigravity-cli\log'
$existingLogs = @()
if (Test-Path $logDir) {
    $existingLogs = @(Get-ChildItem -Path $logDir -Filter "cli-*.log" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
}

# 短網址輔助函式 (僅使用可直接跳轉授權的 TinyURL)
function Get-ShortUrl($url) {
    $enc = [System.Uri]::EscapeDataString($url)
    try {
        $res = (Invoke-RestMethod -Uri ("https://tinyurl.com/api-create.php?url=" + $enc) -UserAgent "curl/8.0.0" -TimeoutSec 5).Trim()
        if ($res -match '^https?://tinyurl\.com/\w+') { return $res }
    } catch {}
    return $url
}

$agy = "$env:LOCALAPPDATA\agy\bin\agy.exe"
if (-not (Test-Path $agy)) {
    $fallbackAgy = Join-Path $env:USERPROFILE '.gemini\bin\agy.exe'
    if (Test-Path $fallbackAgy) { $agy = $fallbackAgy }
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $agy
$psi.Arguments = "--print-timeout=1s -p=done"
$psi.RedirectStandardError = $true
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardInput = $false
$psi.UseShellExecute = $false

try {
    $proc = [System.Diagnostics.Process]::Start($psi)
} catch {
    Write-Host "[ERROR] 無法啟動 agy: $_" -ForegroundColor Red
    exit 1
}

$shortened = $false
while (-not $proc.HasExited) {
    $line = $proc.StandardError.ReadLine()
    if ($null -eq $line) { break }

    if (-not $shortened -and $line -match '(https://accounts\.google\.com\S+)') {
        $shortened = $true
        $fullUrl = $matches[1]
        $shortUrl = Get-ShortUrl $fullUrl

        Write-Host "`n登入授權短網址 (點擊後直達 Google 授權)：" -ForegroundColor Cyan
        Write-Host $shortUrl -ForegroundColor Yellow
        Write-Host ""
    } elseif ($line.Trim().Length -gt 0 -and $line -notmatch 'Error: -p took' -and $line -notmatch 'print timeout' -and $line -notmatch 'AGY_ERROR') {
        Write-Host $line
    }
}

$proc.WaitForExit()

# 精準檢查該次執行的記錄檔以驗證登入真實狀態
$targetLog = $null
if (Test-Path $logDir) {
    $newLogs = @(Get-ChildItem -Path $logDir -Filter "cli-*.log" -ErrorAction SilentlyContinue | Where-Object { $existingLogs -notcontains $_.FullName })
    if ($newLogs.Count -gt 0) {
        $targetLog = $newLogs | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    } else {
        $targetLog = Get-ChildItem -Path $logDir -Filter "cli-*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
}

$authEmail = $null
$authTimedOut = $false
$silentAuth = $false

if ($targetLog) {
    Start-Sleep -Milliseconds 150
    $logContent = Get-Content -Path $targetLog.FullName -ErrorAction SilentlyContinue
    foreach ($logLine in $logContent) {
        if ($logLine -match 'authenticated successfully as (\S+@\S+)') {
            $authEmail = $matches[1]
        }
        if ($logLine -match 'Print mode: silent auth succeeded') {
            $silentAuth = $true
        }
        if ($logLine -match 'Print mode: auth timed out') {
            $authTimedOut = $true
        }
    }
}

if ($authEmail) {
    if ($silentAuth -and -not $shortened) {
        Write-Host "`nℹ️ [提示] 目前已處於登入狀態（已驗證帳號：$authEmail），無需重複登入！" -ForegroundColor Cyan
    } else {
        Write-Host "`n✅ [完成] 登入成功！已驗證帳號：$authEmail，憑證已妥善保存。" -ForegroundColor Green
    }
} elseif ($authTimedOut) {
    Write-Host "`n⏱️ [逾時] 登入流程已超時（未在時限內輸入驗證代碼），憑證未保存。請重新執行腳本。" -ForegroundColor Yellow
} else {
    Write-Host "`n❌ [未完成] 登入未成功（授權代碼無效或已被中斷），憑證未保存。" -ForegroundColor Red
}
