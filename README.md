# harness-plugins

**Coding Agent Harness 插件與擴充合集**：秉持「環境修復」與「原生執行優先」理念見 [`AGENTS.md`](AGENTS.md)，針對不同 Harness (pi、OpenCode 等) 提供輕量、精準、可驗證的擴充功能。

---

## 核心架構演進：全面轉向 PWSH

> **專案重大轉向**：Windows 環境下**已全面改用 PowerShell (pwsh)，不再使用 Bash (git-bash)**。

### 為什麼不用 Bash？
先前本專案曾針對各 Harness 維護複雜的 `env-guard`，試圖修復 Git Bash / MSYS 在 Windows 執行層下的環境轉換病理（如 `MSYS_NO_PATHCONV` 引起的路徑破壞、`/tmp` 錨點錯位、`cmd //c` 互動橫幅偽裝等）。

然而，根據本專案深入的評測與缺陷計分報告（詳見 [`docs/bash-vs-pwsh.md`](docs/bash-vs-pwsh.md)）：
- **PWSH 整體可靠度顯著優於 Bash（評分 −3.0 vs −9.0 ~ −9.5）**。
- **明確報錯 vs 靜默失敗**：PWSH 的陷阱多半在解析階段就拋出具體且可修正的 `ParserError`；而 Bash 在 Windows 下充滿了 `exit 0` 的假成功與嚴重的額外傷害（如 `> nul` 建立真實檔案、未引號反斜線路徑建立錯亂檔名、巢狀引號錯位等），這些屬於 Bash 原生剖析器行為，外掛層根本無法安全修復。
- **開放集合的維護代價**：在輸入側以 Lexer 掃描並改寫 Bash 指令字串是開放集合（Wrapper、引號、Heredoc 等變形無限增長），誤修風險極大，維護成本實質為負無限。

因此，所有針對 Bash 環境修復的 `env-guard` 模組以及停止維護的早期 Host 模組，已全數封存至 [`archive/`](archive/README.md)。

---

## 模組一覽

### native-powershell (pi-extensions)

- **解決問題**：pi 內建的 powershell 工具在 Windows 上硬編碼注入引數（`-NoProfile`, `-NonInteractive`, `-ExecutionPolicy Bypass`），並強行在前綴插入 UTF-8 設定指令碼。這導致進程內省（例如 `(Get-Process -Id $PID).CommandLine`）看到被污染的引數，且使用者自訂的 profile 無法載入。
- **作法**：覆蓋同名 `powershell` 工具，使用原生 `{pwsh} -Command <command>` 乾淨執行，完全不帶多餘參數。
- **轉碼邊界（Transcoding）**：若探測到子行程宣告非 65001 輸出（如 Windows PowerShell 5.1 OEM Big5/GBK），在輸出管道以 `TextDecoder` 串流解碼並轉碼為 UTF-8 Buffer，避免 pi 的 `OutputAccumulator` 發生解碼錯誤。
- **樹狀行程終止**：逾時或中止時呼叫 `taskkill.exe /F /T /PID` 乾淨刪除子進程樹。

### chat-trim-context (oc-plugins)

- **解決問題**：OpenCode 在 `chat` 模式下每次請求會帶入冗長的環境資訊（`<env>` 段落）與 worktree marker，浪費 context 空間。
- **作法**：掛載 `context`、`compaction`、`generate` 鉤子，在發送前將 `<env>` 區塊與 worktree 雜訊清理乾淨。
- **零依賴**：完全不依賴 `@opencode/plugin` 執行期套件，安裝目錄維持在 12 KB 左右。

### 封存模組 (Archived)

已全數移至 [`archive/`](archive/README.md)（歷史技術規格存檔於 [`docs/archive/spec-old.md`](docs/archive/spec-old.md)）：
- `archive/cmdc-mods/`：Command Code 專用模組（`env-guard`, `system-prompt`, `disable-tools`）。因 Host 停止維護且全面轉用 PWSH 而封存。
- `archive/pi-extensions/env-guard/`：pi 的 Bash temp 路徑與 cmd banner 偵測擴充。
- `archive/oc-plugins/env-guard/`：OpenCode 的 Bash 閉集合 temp surface 修復插件。

---

## 安裝指南

各 Host 提供「套件安裝（推薦）」或「手動複製」兩種方式：

### 1. pi (`native-powershell`)
需求：pi ≥ 0.48.0。

```bash
# 套件安裝（推薦）
pi install git:github.com/Artin0123/harness-plugins

# 手動安裝：複製到全域擴充目錄
cp -r pi-extensions/native-powershell ~/.pi/agent/extensions/
```

- 確認載入：`pi list`
- 移除：`pi remove git:github.com/Artin0123/harness-plugins`
- 單次工作階段不載入擴充：`pi --no-extensions`

### 2. OpenCode v2 (`chat-trim-context`)

```bash
# 指令安裝（推薦）
opencode plugin add "github:Artin0123/harness-plugins#master::path:oc-plugins/chat-trim-context"

# 手動安裝：複製到全域或專案外掛目錄
cp -r oc-plugins/chat-trim-context ~/.config/opencode/plugins/
```

- 檢查/更新：`opencode plugin list` / `opencode plugin update chat.trim-context`

---

## 測試與開發

專案遵循嚴格的驗證紀律（見 [`AGENTS.md`](AGENTS.md)），測試程式碼一律置於各 Host 資料夾的 `tests/` 目錄：

```bash
# 執行現行模組測試（pi native-powershell + oc packaging）
npm test

# 分別執行各 Host 現行測試
npm run test:pi      # pi-extensions/tests/native-powershell (15/15 checks passed)
npm run test:oc      # oc-plugins/tests/packaging (11/11 checks passed)
```

環境需求：Node.js ≥ 22.6（支援原生 TypeScript 型別剝離）。

---

## 相關文件

- [`AGENTS.md`](AGENTS.md) — 環境修復插件通用開發原則與審查清單。
- [`docs/bash-vs-pwsh.md`](docs/bash-vs-pwsh.md) — Windows 終端機評測、計分與轉向 PWSH 的論證依據。
- [`docs/spec.md`](docs/spec.md) — 現行模組技術規格書。
- [`docs/archive/spec-old.md`](docs/archive/spec-old.md) — 封存模組歷史技術規格書（含舊版 env-guard 問題分析與未修復問題記錄）。
- [`docs/PLAN.md`](docs/PLAN.md) — OpenCode pwsh-profile-shim 規劃書。
- [`archive/README.md`](archive/README.md) — 封存庫說明文件。
