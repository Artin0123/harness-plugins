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
   - 為何必須整顆自帶 exec：pi 的 operations 介面是全有全無，工具只接受整顆自訂 `operations`；`spawnHook` 雖可改寫 `{command, cwd, env}`，但前綴注入發生在其下游的 `ops.exec` 內部，暴露不到；共用的 exec 引擎 `createLocalShellOperations` 非公開匯出。
   - 連帶重實作的內建語義：cwd 存在性檢查、abort/逾時經 `taskkill.exe /F /T` 終止進程樹、訊號退出碼 `128+n`、env 轉發。這些是整組替換的對等義務，不是新增功能。
2. **Spawn 形式**：以 probe 出的 `shell` 搭配 `["-NonInteractive", "-Command", command]` 執行，指令文字逐字透傳。各引數的取捨均經實測：
   - **捨棄 `-NoProfile`**：`$PROFILE` 是編碼修復點，同時承載使用者的環境變數等需求（部署要求見「部署前提」）。
   - **捨棄 `-ExecutionPolicy Bypass`**：機器原則（如 RemoteSigned）恢復效力。帶 Zone.Identifier 的腳本由 pi 預設的可執行變為 `SecurityError` 拒絕；單次逃生口 `$env:PSExecutionPolicyPreference='Bypass'` 為動態重讀（同一通指令內前置即生效），不出現在命令列上。
   - **保留 `-NonInteractive`**：主機提示必須 fail-fast。缺它時：`Get-Credential` 開出真實桌面憑證對話框，工具呼叫無界掛住（實測 >8s 才被強殺；帶旗標約 540ms 拒絕）；`Read-Host` 靜默回空並續跑（stdin 為 ignore，EOF 被視為空行）；`PromptForChoice` 退化為底層 `MethodInvocationException`。
   - **保留 `-Command` 參數傳輸**：stdin 傳輸（`pwsh -Command -`）雖能讓 CommandLine 零指令文本且 exit code 透傳，但跨行區塊被靜默吞掉（無輸出、exit 0），屬靜默失敗，不可採用。

### 部署前提

- **編碼修復點（$PROFILE）**：headless spawn 每次取得一顆全新隱藏 console（`CREATE_NO_WINDOW`），輸出字碼頁為系統 OEM 值（zh-CN 機器實測 936 / GBK）。A/B 實證：載入 profile → `[Console]::OutputEncoding.CodePage` 為 65001；`-NoProfile` → 936，同一句中文以 GBK 位元組輸出，在 pi 的 UTF-8 擷取層解碼為亂碼。
- **部署決策**：模組不做 in-code 修復，`$PROFILE` 是唯一修復通道。部署只需單一處：getPowerShellConfig 的解析是決定論的（pwsh.exe 在 PATH 就選 7），profile 跟著實際解析結果走；具體部署行見 README 安裝指南。

### 已知差異

- **child pid 追蹤**：內建 exec 將每個 child pid 記入 `trackDetachedChildPid`，宿主在 SIGTERM/SIGHUP/崩潰清理時經 `killTrackedDetachedChildren` 批次擊殺。該登記簿與共用 exec 引擎同為 `utils/shell.js` 內部狀態（套件入口僅公開匯出 `getPowerShellConfig` / `getShellConfig`），mod 無法掛入；自建訊號處理則有雙重處理風險，依「寧可漏修，絕不誤修」不補。後果：pi 於指令執行中被訊號終止時，mod 啟動的行程樹不會被宿主清理（abort/逾時路徑不受影響，由 mod 自行 taskkill，taskkill 本身已補上 `detached: true` 以活過宿主死亡）。

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
  驗證 pi powershell 工具的原生 spawn 行為（14 項檢查全綠）。
  - 參數內省：`(Get-Process -Id $PID).CommandLine` 呈現為 `-NonInteractive -Command <指令>`；無 host 注入的 `-NoProfile`、`-ExecutionPolicy`、UTF-8 前置碼，且與直接 spawn 的結果一致。
  - 離開碼透傳：`exit 2` 原樣回傳。
  - 非 ASCII 透傳：先探測 child 的 `[Console]::OutputEncoding.CodePage`；部署前提達成時驗 `漢字` 以 UTF-8 正確解碼，前提缺席時標記 SKIPPED 並註明 mod 逐字透傳不受影響（該項是部署前提探測，不是 mod 行為驗收）。
  - 提示 fail-fast：`PromptForChoice`、`Get-Credential`、`Read-Host` 在 `-NonInteractive` 下快速拋錯而非掛住（每項含 10 秒防護且失敗彼此隔離）。
  - 超時與中止：逾時與 AbortSignal 觸發時執行 `taskkill` 樹狀終止。
  - 原始碼不變式：無轉碼層機制；`$PROFILE` 部署要求與 `-NonInteractive` 保留理由均在檔頭如實記載。
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
