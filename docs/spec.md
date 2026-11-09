# 技術規格（spec）

使用者須知（修復項目、輸出變化、設定方式與統計查看）請參閱根目錄
[`README.md`](../README.md)；這份記**現行技術架構、設計判準與實測證據**。通用判準
（原生執行優先、修復審查清單、驗證紀律）見 [`AGENTS.md`](../AGENTS.md)，此處不重複。

---

## 架構現狀

Windows 環境全面轉向原生 PowerShell（PWSH），捨棄 Bash 環境修復層。轉向的理由、實測數據與封存原因都記在 [`README.md`](../README.md) 與 [`docs/bash-vs-pwsh.md`](bash-vs-pwsh.md)，此處不重複。

本文件 §1–§3 即現行全部三個模組；退役與封存模組（pi 與 oc 的 `env-guard`、`pwsh-profile-shim`）記載在 [`archive/README.md`](../archive/README.md)，歷史規格書見 [`docs/archive/spec-old.md`](archive/spec-old.md)。

---

# 現行模組規格（Active Specifications）

## 1. native-powershell (pi-extensions)

- **目標**：為 pi coding agent 提供乾淨、原生、無污染的 PowerShell / PWSH 執行能力，覆蓋內建同名工具。
- **原始碼**：[`pi-extensions/native-powershell/index.ts`](../pi-extensions/native-powershell/index.ts)
- **測試**：[`pi-extensions/tests/native-powershell/index.mjs`](../pi-extensions/tests/native-powershell/index.mjs)

### 故障點分析

pi 內建的 `createPowerShellTool` 在 Windows 上會強行注入預設引數（無任何設定可關）：
- 寫死 `POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]`。
- 在傳入指令前強行插入 `try { [Console]::OutputEncoding = ... }` 等 UTF-8 設定指令碼。
- **副作用**：查看行程啟動參數的地方（例如 `(Get-Process -Id $PID).CommandLine`）看到的是被污染的參數與雜訊字串，Agent 無法精確確認自己送出的命令是以什麼形式被執行的；使用者自訂的 PowerShell Profile 也被強行抹除。

### 機制

修復用的是 pi 允許的路線：**註冊同名工具覆蓋內建版**（`pi.registerTool(createPowerShellTool(...))`）。註冊之後，pi 呼叫 powershell 工具時執行的就是模組自己的實作，內建版完全不會被呼叫；pwsh 行程也改由模組自己的 exec 引擎啟動，啟動參數與命令內容都由模組決定，pi 不再往裡面加東西。

不採用較小的掛點 `spawnHook`，因為它的能力範圍不含啟動參數：pi 提供給工具的 `spawnHook` 只允許修改命令文字、工作目錄與環境變數三樣東西；`-NoProfile` 這一類啟動參數是由 pi 內部 exec 引擎組出來的，組參數的程式碼不對插件開放，`spawnHook` 改不了它。

覆蓋之後內建版不再執行，它原本對使用者有價值的行為要由模組自己實作：工作目錄不存在時報錯；逾時或被取消時用 `taskkill /F /T` 結束 pwsh 與其全部子行程。與 oc 版的差別在於：oc 的插件面只有 `shell.create.before` hook，僅允許修改命令文字，改不到啟動參數，所以 oc 版只能把 profile 載入碼接在命令前面（見 §3）；pi 版直接控制啟動參數本身。不加任何其他功能。

實際送給 pwsh 的形式是 `pwsh -NonInteractive -Command <命令>`，命令文字逐字透傳——關鍵就在那兩個「不送」：

- **不送 `-NoProfile`**：這是修復點本身。pwsh 每次啟動會自動載入個人層的 profile 腳本，使用者的 UTF-8 編碼與環境（PATH 補 git、python 虛擬環境）就佈署在這裡；去掉這個參數，這層個人設定才會在 pi 的命令裡生效（profile 的佈署方式見「部署前提」）。
- **不送 `-ExecutionPolicy Bypass`**：讓機器自己的執行原則（例如本機腳本須簽章）照常生效——這也是個可以實測的效果差異：同一個帶封印記錄（Zone.Identifier）的腳本，內建工具照跑，修復後的工具被原則以 `SecurityError` 拒絕。真的需要繞過某一次，就在那道命令前先行 `$env:PSExecutionPolicyPreference='Bypass'`，pwsh 讀到即生效，不會出現在啟動參數上。
- **保留 `-NonInteractive`**：少了它，命令要求輸入帳號密碼時會跳出一個真的視窗，把整次呼叫卡到被外部強制收掉（實測帶它約 540ms 內拒絕、不帶掛過 8 秒），所以必須保留。
- **命令經 `-Command` 送入，不走 stdin**：把命令送進 pwsh 有兩種方式——作為 `-Command` 的參數值，或 spawn 後從 stdin 餵入。模組用前者；stdin 餵法雖然能讓命令文字不出現在行程命令列上、啟動參數更乾淨，但多行命令會被靜默吞掉（無輸出、exit 0 假成功），不能用。

### 部署前提

- **編碼修復點（$PROFILE）**：headless spawn 每次取得一顆全新隱藏 console（`CREATE_NO_WINDOW`），輸出字碼頁為系統 OEM 值（zh-CN 機器實測 936 / GBK）。A/B 實證：載入 profile → `[Console]::OutputEncoding.CodePage` 為 65001；`-NoProfile` → 936，同一句中文以 GBK 位元組輸出，在 pi 的 UTF-8 擷取層解碼為亂碼。
- **部署決策**：模組不做 in-code 編碼修復——自己再往命令前塞編碼碼，就會重演內建工具那套污染（這正是本模組要修掉的東西）；在「命令零注入」的約束下，`$PROFILE` 是僅剩的修復通道。具體部署步驟見 README 安裝指南。

### 已知差異

- **child pid 追蹤**：內建 exec 將每個 child pid 記入 `trackDetachedChildPid`，宿主在 SIGTERM/SIGHUP/崩潰清理時經 `killTrackedDetachedChildren` 批次擊殺。該登記簿與共用 exec 引擎同為 `utils/shell.js` 內部狀態（套件入口僅公開匯出 `getPowerShellConfig` / `getShellConfig`），mod 無法掛入；自建訊號處理則有雙重處理風險，依「寧可漏修，絕不誤修」不補。後果：pi 於指令執行中被訊號終止時，mod 啟動的行程樹不會被宿主清理（abort/逾時路徑不受影響，由 mod 自行 taskkill，taskkill 本身已補上 `detached: true` 以活過宿主死亡）。

---

## 2. chat-trim-context (oc-plugins)

- **目標**：針對 OpenCode 的 `chat` agent，在每次送出模型請求前清理系統提示中的多餘資訊。
- **原始碼**：[`oc-plugins/chat-trim-context/index.ts`](../oc-plugins/chat-trim-context/index.ts)
- **測試**：[`oc-plugins/tests/packaging/index.mjs`](../oc-plugins/tests/packaging/index.mjs)

### 機制

掛在 `ctx.session.hook` 的 `context`、`compaction`、`generate` 三個時機點，只處理 `chat` agent 的請求。實際效果：模型收到的系統提示不含環境描述——以「Here is some useful information about the environment you are running in:」或「The environment you are running in is now:」開頭的段落被移除；提示其餘部分逐字不變（第一個區塊與非文字區塊一律原樣保留）。

---

## 3. pwsh-profile-loader (oc-plugins)

- **目標**：讓 OpenCode shell 工具 spawn pwsh/powershell 時載入使用者的 PowerShell profile，個人設定與直接開終端一致。
- **原始碼**：[`oc-plugins/pwsh-profile-loader/index.ts`](../oc-plugins/pwsh-profile-loader/index.ts)
- **測試**：[`oc-plugins/tests/pwsh-profile-loader/index.mjs`](../oc-plugins/tests/pwsh-profile-loader/index.mjs)
- **技術記錄**：[`docs/archive/PLAN.md`](archive/PLAN.md)（決策與量測日誌、計畫推演歷史）。

### 機制

- OpenCode 執行 pwsh/powershell 命令時，照 pwsh 原生順序（AllUsersAllHosts → AllUsersCurrentHost → CurrentUserAllHosts → `$PROFILE`）先載入四個 profile 檔，之後才執行原命令；實作上是 `shell.create.before` hook 在命令前插入固定前綴（794 字符）。
- 插件唯一新增的行為就是載入使用者自己的 profile——與手動移除 `-NoProfile` 會載入的內容相同，命令其餘部分逐字不變。
- profile 出錯不影響命令：錯誤照 pwsh 原生格式出現在輸出裡，原命令照常執行。
- 同一道命令重複送達不會疊加前綴；profile 全不存在時前綴什麼也不做。
- 掃描與 permission 判定在改寫之前以原始命令完成，不受影響。
- 改寫一定生效（v2.2.6 實測）：宿主在 hook 執行完之後才讀取 `event.command`，hook 改過的內容就是實際執行的內容。

### Inert 條件

非 pwsh/powershell shell、命令非字串或空、shell 值無路徑分隔符、OpenCode 缺 hook 表面——整體停用、不註冊、不報錯。

### 成本

每次命令 +0–1 毫秒（794 字符前綴解析＋3 個存在守衛）＋ 執行使用者 profile 內容的時間（本機 ~90 毫秒，由 profile 內容決定）。系統上無部署物、無編譯。

---

# 測試

測試與插件資料夾分離——插件資料夾保持只含交付物，手動安裝（`cp -r` 插件資料夾）不會把測試帶進安裝目錄。

## 現行模組測試

- **`pi-extensions/tests/native-powershell/index.mjs`**（14 項檢查）：測試直接執行真的 pwsh，看它實際怎麼被啟動、怎麼結束，不檢查源碼裡寫了什麼。確認的內容：pwsh 收到的啟動參數是 `-NonInteractive -Command`，沒有 `-NoProfile`、`-ExecutionPolicy` 和 UTF-8 前置碼，而且與手動直接執行 pwsh 的結果一致；命令的離開碼原樣回傳；逾時或被取消時整棵行程樹被結束；命令要求輸入（`PromptForChoice`、`Get-Credential`、`Read-Host`）時立刻拋錯結束，不會卡住等待。中文編碼那一項會先看環境裡的 profile 部署好了沒：沒部署時標記 SKIPPED 而不是判定失敗——它檢查的是環境前提，不是 mod 本身（mod 只透傳輸出，不碰編碼）。
- **`oc-plugins/tests/packaging/index.mjs`**（22 項檢查）：發布前檢查 package.json 與插件檔案的完整性。package.json 部分：插件不宣告任何依賴欄位（npm 安裝插件時不會自動下載大量模組）、`main` 指向的檔案確實存在、名稱以 `opencode-` 開頭。插件程式碼部分：不 import `@opencode/plugin`。兩個插件唯一用到的宿主介面只有 `define` 一個函式，而它實際上只是把傳入的插件原樣回傳（順便標註型別），所以在插件檔案裡自己宣告一個一模一樣的就夠了。真的去 import 的話，npm 安裝插件時會連宿主套件整串一起抓（實測一次安裝多下載 273 個套件、168 MB）；改為本地宣告後，每次安裝只多插件本身 1 個套件、42 KB。匯出的插件物件要有 `id` 和 `setup`。插件程式碼這幾項 loader 測試也會查到（它把插件真的 import 進來執行，缺了任何一項 import 就會失敗）；package.json 的部分只有 packaging 會查。
- **`oc-plugins/tests/pwsh-profile-loader/index.mjs`**（20 項檢查）：測試只看插件實際執行的輸出，不看源碼寫了什麼。分兩層：第一層把插件真的載入進來、跑一次 hook，看它改寫了什麼——pwsh/powershell 的命令要加前綴、bash 不動、命令不是字串或空白不動、命令裡已經有載入碼時不會再加一次、四個 profile 檔逐一確認後載入且哪個出錯就用 pwsh 原生的錯誤格式報出來、OpenCode 沒有這個 hook 時整個插件不動作；第二層拿改寫出來的前綴真的去執行 pwsh，證明前綴確實載入 profile 且不干擾原命令——「確實載入」的證據是把環境裡的 git 移除後由 profile 加回來；另外確認離開碼原樣回傳、profile 全不存在時前綴什麼也不做、profile 出錯時錯誤照 pwsh 原生格式出現在 stderr 且命令照常執行、profile 裡定義的變數和函式命令都取用得到。

執行現行測試：
```bash
npm run test:pi   # pi-extensions native-powershell（14 項）
npm run test:oc   # oc 插件 packaging 檢查（22 項）＋ pwsh-profile-loader 測試（20 項）
```

執行環境：Node.js ≥ 22.6（測試與插件都以 Node 內建的 TypeScript 型別剝離功能直接執行，不需編譯）。

## 封存模組測試 (Archive)

封存的測試套件（五套回歸測試＋退役方案 pwsh-profile-shim 的 11 項測試）與其 node 直跑執行方式，記載在 [`archive/README.md`](../archive/README.md)。

---

# 封存模組歷史技術規格

舊版環境修復層（`pi-extensions/env-guard`、`oc-plugins/env-guard`）之完整歷史技術架構、設計判準、問題根因分析（`MSYS_NO_PATHCONV` 閘門、temp 錨點、使用統計分類學、以及「只能靠寫對的情境」與「未修復問題記錄」）均已完整留存於：

👉 **[`docs/archive/spec-old.md`](archive/spec-old.md)**
