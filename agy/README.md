# Antigravity CLI (agy) 輔助工具集

本目錄包含針對 Google Antigravity CLI (`agy`) 設計的認證、Token 輔助與請求結構抓包工具，專門解決遠端裝置（如手機 SSH）、無 OAuth 介面環境（如 iframe 視窗）以及客製代理 Schema 檢驗的需求。

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

### 3. `agy/capture_schema.py`（本地 Schema 抓包與代理檢驗）
- **主要用途**：利用 `agy` 原生支援的 `modelProvider: "gemini"` 與 `GOOGLE_GEMINI_BASE_URL` 環境變數，在本地啟動輕量 Gemini API 模擬伺服器，精準捕獲 `agy` 發送給模型的完整請求 JSON（包含 `systemInstruction`、`functionDeclarations`、`contents`、`generationConfig` 等）。
- **實測對照發現（預設代理 vs `clean-template`）**：
  - **系統提示詞精簡 99%**：原生預設代理的 `systemInstruction` 高達 **19,254 字元**（含 `<identity>`、`<artifacts>`、`<skills>`、`<slash_commands>`、`<user_rules>` 等）；而在啟用 `excludeDefaultComponents: true` 的 `clean-template` 下，提示詞縮水至僅 **125 字元**（僅保留自訂的 System Prompt 正文）。
  - **工具宣告（`functionDeclarations`）精確控制**：預設代理會掛載 13 支工具；在 `clean-template` 下會關閉子代理、排程、搜尋等預設組件建構器，僅掛載核心基礎的 6 支工具（`read_file`、`write_file`、`edit_file`、`run_command`、`manage_task`、`ask_question`）。若自訂 `tools:` 進一步精簡，更可縮減至指定的極少數工具。

---

## 使用方式

### 一、遠端執行一行指令 (One-Liners)

無需預先下載腳本至本機，直接在終端機執行即可：

> [!NOTE]
> 請注意：PowerShell 的 `irm` (`Invoke-RestMethod`) 必須請求 **Raw 原始碼網址**（`raw.githubusercontent.com` 或 `/raw/master/`），若使用 GitHub 網頁介面的 `/blob/` 網址會抓取到 HTML 網頁而無法被 `iex` 執行。

#### 1. 遠端登入（手機 SSH）

- **在 CMD / Bash / SSH 中直接執行**：
  ```bash
  pwsh -Command "irm https://raw.githubusercontent.com/Artin0123/harness-setup/master/agy/login.ps1 | iex"
  ```
- **在已開啟的 PowerShell (`pwsh`) 中執行**：
  ```powershell
  irm https://raw.githubusercontent.com/Artin0123/harness-setup/master/agy/login.ps1 | iex
  ```

#### 2. 獲取 Access Token 到剪貼簿（iframe / 嵌入視窗連線）

- **在 CMD / Bash / 本地終端中直接執行**：
  ```bash
  pwsh -Command "irm https://raw.githubusercontent.com/Artin0123/harness-setup/master/agy/get-agy-token.ps1 | iex"
  ```
- **在已開啟的 PowerShell (`pwsh`) 中執行**：
  ```powershell
  irm https://raw.githubusercontent.com/Artin0123/harness-setup/master/agy/get-agy-token.ps1 | iex
  ```

---

### 二、Schema 抓包測試使用方式 (`capture_schema.py`)

#### 方式 A：一鍵自動抓包（推薦，自動開服、調用 `agy`、存檔後退出）

```bash
# 自動檢驗 clean-template 代理送出的 Schema，並輸出到 captures 目錄
python agy/capture_schema.py --run-agy --agent clean-template --model gemini-3.8-flash-low --out-dir ./captures
```

#### 方式 B：常駐代理模式（手動執行自訂 `agy` 指令）

1. **視窗一（啟動本地代理監聽）**：
   ```bash
   python agy/capture_schema.py --port 8765 --out-dir ./captures
   ```
2. **視窗二（將 `agy` 導向本地代理發送請求）**：
   ```powershell
   $env:GEMINI_API_KEY="dummy"
   $env:GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:8765"
   agy --settings='{"modelProvider":"gemini"}' --model=gemini-3.8-flash-low --agent clean-template -p="hii"
   ```
   產生的捕獲檔案會以 `capture_01.json`、`capture_02.json` 依序存放在指定輸出目錄中。
