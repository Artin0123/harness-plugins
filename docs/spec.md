# 技術規格（spec）

使用者須知（修復項目、輸出變化、設定方式與統計查看）請參閱根目錄
[`README.md`](../README.md)；這份記**現行技術架構、設計判準與實測證據**。通用判準
（原生執行優先、修復審查清單、驗證紀律）見 [`AGENTS.md`](../AGENTS.md)，此處不重複。

---

## 架構演進：全面轉向 PWSH 與 Bash 修復層封存

專案在 Windows 環境下**已經全面轉向使用原生 PowerShell（PWSH），不再使用 Bash（Git Bash / MSYS）**。

### 轉向理由與實測依據（詳見 [`docs/bash-vs-pwsh.md`](bash-vs-pwsh.md)）

先前專案針對各 Harness 開發了複雜的 `env-guard` 修復層，試圖修復 Git Bash / MSYS 在 Windows 執行層下的環境轉換問題。但經過完整的評測計分與實證：
1. **可靠度差距巨大（PWSH −3.0 vs Bash −9.0 ~ −9.5）**：
   - PWSH 的常見問題多半在語法剖析階段即拋出清晰明確的錯誤（ParserError），Agent 收到後能精準自癒。
   - Bash 在 Windows 下存在大量**靜默失敗**（如 `exit 0` 的偽成功）與**額外傷害**（如 `> nul` 建立真實檔案、未加引號反斜線路徑建立怪檔、巢狀引號錯亂），這些純屬 Bash 剖析器行為，外掛與 `.bashrc` 在維持正確語法的前提下根本無法修復。
2. **`MSYS_NO_PATHCONV` 兩難與開放集合陷阱**：
   - 不設轉換（`=0`）會改壞 `/owner/repo` 這類資料參數；關閉轉換（`=1`）則破壞 POSIX 路徑與環境變數前綴。外掛若在輸入側以 Lexer 改寫指令字串，必須窮舉所有 Wrapper 與語法邊界，屬於開放集合；誤修代價遠大於漏修（維護代價實質為負無限）。
3. **治本解決方案**：
   - 遵從《[AGENTS.md](../AGENTS.md)》的「治本不治標」與「原生執行優先」原則，全面切換至 Windows 原生支援的 PWSH，徹底廢棄脆弱的 Bash 環境修復層。

因此，架構劃分為：
- **現行模組（Active）**：專注於 PWSH 原生支援與乾淨執行（`pi-extensions/native-powershell`）、以及 OpenCode 的對話情境清理（`oc-plugins/chat-trim-context`）與 pwsh-profile-shim（規劃中，見 [`docs/PLAN.md`](PLAN.md)）。
- **封存模組（Archived）**：舊有的 `cmdc-mods` 全系列、以及 pi 和 oc 的 `env-guard` 全數移入 [`archive/`](../archive/README.md)；其完整的歷史技術規格與病理分析已封存至 [`docs/archive/spec-old.md`](archive/spec-old.md)。

---

# 現行模組規格（Active Specifications）

## 1. native-powershell (pi-extensions)

- **目標**：為 pi coding agent 提供乾淨、原生、無污染的 PowerShell / PWSH 執行能力，覆蓋內建同名工具。
- **原始碼**：[`pi-extensions/native-powershell/index.ts`](../pi-extensions/native-powershell/index.ts)
- **測試**：[`pi-extensions/tests/native-powershell/index.mjs`](../pi-extensions/tests/native-powershell/index.mjs)

### 故障點分析
pi 內建的 `createPowerShellTool` 在 Windows 上會強行注入預設引數：
- 寫死 `POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]`。
- 在傳入指令前強行插入 `try { [Console]::OutputEncoding = ... }` 等 UTF-8 設定指令碼。
- **副作用**：進程內省（例如 `(Get-Process -Id $PID).CommandLine`）看到的是被污染的參數與雜訊字串，阻礙了 Agent 進行精確的行程自我檢查，且使用者自訂的 PowerShell Profile 被強行抹除。

### 修復機制
1. **同名工具覆蓋**：以 `pi.registerTool(createPowerShellTool(process.cwd(), { operations }))` 覆蓋內建的 `powershell` 工具。
2. **原生乾淨 Spawn**：直接以 `shell`（依序 probe 出的 `pwsh` 或 `powershell`）搭配 `["-Command", command]` 執行，完全不注入任何 `-NoProfile`、`-NonInteractive` 或前置指令碼。
3. **編碼邊界轉碼（Transcoding Boundary）**：
   - 探測目標 shell 的輸出字碼頁：`[Console]::OutputEncoding.CodePage`（快取結果）。
   - 若為 `65001`（現代 pwsh 預設），直接 raw pass-through。
   - 若為非 65001（例如 Windows PowerShell 5.1 繁體中文預設 950 / Big5 或簡體 936 / GBK），以 `TextDecoder` 進行 chunk-by-chunk 串流解碼，並重新編碼為 UTF-8 Buffer 傳遞給 pi 的 `OutputAccumulator`。
   - 僅修復轉碼邊界（因為 pi 的解碼器只接受 BufferSource，字串會拋 TypeError），不更動指令文字與命令語意。
4. **樹狀行程終止（Tree Kill）**：
   - 當收到 abort 訊號或逾時（`timeout`）時，透過 `taskkill.exe /F /T /PID <child.pid>` 確保整個進程樹（包含 PowerShell 啟動的子進程）徹底清理，避免殘留孤兒進程。

---

## 2. chat-trim-context (oc-plugins)

- **目標**：針對 OpenCode 的 `chat` agent，在每次送出模型請求前清理系統提示中的多餘資訊。
- **原始碼**：[`oc-plugins/chat-trim-context/index.ts`](../oc-plugins/chat-trim-context/index.ts)
- **測試**：[`oc-plugins/tests/packaging/index.mjs`](../oc-plugins/tests/packaging/index.mjs)

### 機制
掛載 `ctx.session.hook` 的三個時機點：
- `context`
- `compaction`
- `generate`

在發送請求前執行文字清理：
1. 移除 `<env>...</env>` 環境資訊區塊。
2. 移除包含 worktree marker（`tools.opencode.session_move`）的段落，降低上下文雜訊並節省 Token。
3. 遵循 OpenCode 插件零依賴（Zero Dependencies）原則，安裝體積維持在 12 KB 左右。

---

## 3. pwsh-profile-shim (規劃中)

- **目標**：讓 OpenCode shell 工具在 spawn pwsh/powershell 時載入使用者 PowerShell Profile，同時保持掃描器（permission 資源提取、語法判定）為 PowerShell 模式。
- **技術計畫書**：[`docs/PLAN.md`](PLAN.md)

---

# 測試

測試與插件資料夾分離——插件資料夾保持只含交付物，手動安裝（`cp -r` 插件資料夾）不會把測試帶進安裝目錄。

## 現行模組測試
- **`pi-extensions/tests/native-powershell/index.mjs`**：
  驗證 pi powershell 工具的原生 spawn 行為（15 項檢查全綠）。
  - 參數內省：確保 `(Get-Process -Id $PID).CommandLine` 只包含原生 `-Command`，絕無 host 注入的 `-NoProfile`、`-NonInteractive` 等雜訊。
  - 離開碼透傳：確保 exit code（如 exit 2）原樣回傳。
  - 轉碼邊界：Big5 / IBM437 串流轉碼為 UTF-8 Buffer，包含跨 chunk 切割與尾端截斷補字元（`\uFFFD`）驗證。
  - 超時與中止：逾時與 AbortSignal 觸發時執行 `taskkill` 樹狀終止。
- **`oc-plugins/tests/packaging/index.mjs`**：
  OpenCode 插件的打包與零依賴體積防護檢查（11 項檢查全綠）。
  - 確保無 `dependencies` / `peerDependencies` / `optionalDependencies` 欄位（避免 npm 自動下載數百 MB 模組）。
  - 確保無 `@opencode/plugin` 的 runtime import（以本地 identity define shim 取代）。
  - 確保 default export 具備 `{ id, setup }` 正確形狀。

執行現行測試：
```bash
npm test          # 執行 pi 與 oc 現行測試
npm run test:pi   # 僅執行 pi native-powershell 測試
npm run test:oc   # 僅執行 oc packaging 測試
```

## 封存模組測試 (Archive)
封存的測試套件置於 `archive/<host>/tests/`，歷史測試斷言與防回歸機制維持完整可用：
- `archive/cmdc-mods/tests/env-guard/index.mjs`（175 項）
- `archive/cmdc-mods/tests/system-prompt/index.mjs`（8 項）
- `archive/cmdc-mods/tests/disable-tools/index.mjs`（9 項）
- `archive/pi-extensions/tests/env-guard/index.mjs`（48 項）
- `archive/oc-plugins/tests/env-guard/index.mjs`（110 項）

執行封存測試：
```bash
npm run test:archive
```

---

# 封存模組歷史技術規格

舊版環境修復層（包含 `cmdc-mods` 全系列、`pi-extensions/env-guard`、`oc-plugins/env-guard`）之完整歷史技術架構、設計判準、問題根因分析（`MSYS_NO_PATHCONV` 閘門、temp 錨點、使用統計分類學、以及「只能靠寫對的情境」與「未修復問題記錄」）均已完整留存於：

👉 **[`docs/archive/spec-old.md`](archive/spec-old.md)**
