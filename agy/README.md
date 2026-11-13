# Antigravity CLI (agy) 輔助腳本

本目錄包含針對 Google Antigravity CLI (`agy`) 設計的認證與 Token 輔助工具，專門解決遠端裝置（如手機 SSH）與無 OAuth 介面環境（如 iframe 視窗）的連線需求。

---

## 腳本功能說明

### 1. `agy/login.ps1`（遠端裝置登入輔助）
- **主要用途**：讓遠端連線裝置（例如透過手機 SSH 連進 Windows 電腦）能夠輕鬆完成 Google OAuth 登入。
- **解決的痛點**：
  - 原生 `agy` 產生的 Google OAuth 授權網址長達數百字元，在手機 SSH 終端中極難點擊與複製。
  - 本腳本會即時攔截網址並轉換為 **TinyURL 直達短網址**，點擊後手機瀏覽器即可直接登入 Google 取得授權碼，貼回終端機即完成登入。
  - 若已處於登入狀態，會自動辨識並提示「無需重複登入」，避免多餘等待。

### 2. `agy/get-agy-token.ps1`（無法 OAuth 環境的 Token 提取器）
- **主要用途**：提供給無法進行標準 OAuth 互動流程的環境（例如嵌入式 iframe 視窗、無頭工作環境），使其可透過已授權的 Access Token 連線。
- **解決的痛點**：
  - 免帶參數，執行時自動透過 `agy models` 發起一次認證請求以確保 Token 處於最新刷新狀態。
  - **雙來源備援讀取**：Windows SSH 連線（Type 3 Network Logon）會隔離 Windows 憑證庫，本腳本能同時搜尋 Windows 憑證管理員（`gemini:antigravity`）與本地檔案（`~/.gemini/antigravity-cli/antigravity-oauth-token`），自動挑選最新有效的 Token。
  - **安全防洩漏**：不直接在終端機印出敏感的 raw access token，而是直接將 Token 複製到系統剪貼簿，僅在畫面上顯示帳號、長度與剩餘有效分鐘數。

---

## 一行遠端執行指令 (One-Liners)

無需預先下載腳本至本機，直接在終端機執行即可：

> [!NOTE]
> 請注意：PowerShell 的 `irm` (`Invoke-RestMethod`) 必須請求 **Raw 原始碼網址**（`raw.githubusercontent.com` 或 `/raw/master/`），若使用 GitHub 網頁介面的 `/blob/` 網址會抓取到 HTML 網頁而無法被 `iex` 執行。

### 1. 遠端登入（手機 SSH）

- **在 CMD / Bash / SSH 中直接執行**：
  ```bash
  pwsh -Command "irm https://raw.githubusercontent.com/Artin0123/harness-setup/master/agy/login.ps1 | iex"
  ```
- **在已開啟的 PowerShell (`pwsh`) 中執行**：
  ```powershell
  irm https://raw.githubusercontent.com/Artin0123/harness-setup/master/agy/login.ps1 | iex
  ```

### 2. 獲取 Access Token 到剪貼簿（iframe / 嵌入視窗連線）

- **在 CMD / Bash / 本地終端中直接執行**：
  ```bash
  pwsh -Command "irm https://raw.githubusercontent.com/Artin0123/harness-setup/master/agy/get-agy-token.ps1 | iex"
  ```
- **在已開啟的 PowerShell (`pwsh`) 中執行**：
  ```powershell
  irm https://raw.githubusercontent.com/Artin0123/harness-setup/master/agy/get-agy-token.ps1 | iex
  ```
