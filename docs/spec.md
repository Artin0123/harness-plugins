# 技術規格（spec）

本文件記錄**決策、成立條件與實測數據**。安裝方式、代價與使用說明在根目錄 [`README.md`](../README.md)；程式碼怎麼運作寫在原始碼的註解裡（[`pi-agent/native-powershell/index.ts`](../pi-agent/native-powershell/index.ts) 等），本文件不重述。通用開發原則（原生執行優先、修復審查清單、驗證紀律）寫在 [`AGENTS.md`](../AGENTS.md)。

---

## 架構現狀：Windows 上使用原生 PowerShell

本專案原本為每個 Harness 各維護一套 `env-guard`，修復 Git Bash 在 Windows 上的環境轉換問題。這套修復層已停止維護，設置與歷史規格封存於 [`archive/README.md`](../archive/README.md) 與 [`docs/archive/spec-old.md`](archive/spec-old.md)。

評測與計分在 [`docs/bash-vs-pwsh.md`](bash-vs-pwsh.md)，本文件不重複評測內容。結論是 PowerShell 得 −3.0，Bash 加上 `.bashrc` 三段修復之後最好也只有 −8.0，兩者相差 5 分。−8.0 這個上限本身已經包含修復加分，而本機的 `.bashrc` 確實套用了那三段修復（實測 `$TMPDIR` 為 `C:/Users/artin/AppData/Local/Temp`，`type -t cmd`、`type -t taskkill`、`type -t findstr` 都回報 `function`），所以本機的 Bash 就落在這個上限；即使如此仍然低於 PowerShell。

### 放棄 Bash 的三個依據

- **故障的形狀不同**：PowerShell 的問題大多在解析階段就以具體的 `ParserError` 停下，看得懂也改得動。Bash 在 Windows 上大量出現離開碼 0 的假成功，還附帶真實的破壞。
- **破壞是 Bash 剖析器本身造成的**：`> nul` 會建立一個真的檔案；未加引號的反斜線路徑會建立出錯亂的檔名；`cmd /c` 裡的巢狀引號會錯位並產生怪檔。以上三種現象都屬 bash 自己的重導向與引號規則，`.bashrc` 攔不到。
- **寫法窮舉不完**：要在指令送進 Bash 之前逐字解析並改寫，等於要窮舉所有可能的寫法（外層再包一層引號、改用 heredoc、透過其他程式繞進來），變形會無限增長，改錯一個字就是災難。依計分規則，這一類修法算負無限，不採用。

---

## 1. native-powershell（pi 擴充）

- **原始碼**：[`pi-agent/native-powershell/index.ts`](../pi-agent/native-powershell/index.ts)
- **測試**：[`pi-agent/tests/native-powershell/index.mjs`](../pi-agent/tests/native-powershell/index.mjs)
- **目標**：pi 內建的 PowerShell 工具與本擴充之間的差異，只有「少兩個啟動旗標」。

### 成因

pi 內建的 `createPowerShellTool` 把啟動參數寫死成一組常數（`dist/utils/shell.js` 的 `POWERSHELL_ARGS`，v1.5.0 實測），而且沒有任何設定可以關閉：

```
POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]
```

這組常數裡有兩個參數造成實際故障：

1. **`-NoProfile`**：使用者自訂的 PowerShell profile 永遠不會被載入。profile 裡的編碼設定、PATH 補充、虛擬環境啟用，在 pi 的每一道命令裡全部失效。
2. **`-ExecutionPolicy Bypass`**：機器本身的腳本執行原則（例如要求本機腳本必須簽章）被直接繞過。

### 為什麼不能只改啟動參數

pi 對 shell 的啟動方式提供兩條改動路徑，都碰不到啟動參數：

- `spawnHook` 只能修改命令文字、工作目錄與環境變數三樣東西。啟動參數由 pi 內部的 exec 程式組出來，組參數的程式碼不對擴充開放。
- `PowerShellToolOptions` 只開放 `operations`、`exposeSessionEnvironment` 與 `spawnHook` 三個欄位，沒有一個能改動啟動參數。

因此擴充採用 `pi.registerTool(createPowerShellTool(process.cwd(), { operations }))`：註冊同名工具取代內建版，pi 呼叫 `powershell` 工具時執行的是擴充的實作，pwsh 行程由擴充自己啟動。代價是內建版原本替使用者做的事情必須由擴充自己實作，因此套件入口沒有匯出的部分（本地 shell 後端、`getShellEnv`、子行程 pid 登記簿）只能自行複製或放棄，逐項後果列在「已知差異」。

深層匯入 `dist/core/tools/bash.js` 的替代路線也驗證過不可行：實測得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`。入口匯出的 `createLocalPowerShellOperations` 本身就會注入那組啟動參數與 UTF-8 指令，正好是要改動的內容，不能沿用。

### 保留 UTF-8 指令與 `-NonInteractive`

這兩項都不在故障範圍，擴充照原樣保留。UTF-8 指令的理由是可量測的：由程式直接啟動、沒有終端可繼承的 pwsh（headless spawn），輸出字碼頁是系統的 ANSI 值，不是 UTF-8。本機（zh-CN 系統）實測，pwsh 7 與 Windows PowerShell 5.1 的行為相同：

| 命令前面有沒有那段 UTF-8 指令 | `[Console]::OutputEncoding` | `Write-Output '漢字AB'` 的原始位元組 | 以 UTF-8 解碼的結果 |
| ----------------------------- | --------------------------- | ------------------------------------ | ------------------- |
| 沒有（profile 也沒設定）      | 936／gb2312                 | `9d 68 d7 d6 41 42`                  | `�h��AB`            |
| 有（不論 profile 有沒有設定） | 65001／utf-8                | `e6 bc a2 e5 ad 97 41 42`            | `漢字AB`            |

`9d 68 d7 d6` 就是 `[System.Text.Encoding]::GetEncoding(936).GetBytes("漢字AB")` 的輸出，代表 GBK 編碼的「漢字」；pi 的輸出擷取層以 UTF-8 解碼子行程的輸出。單獨驗證那段指令的效果：`pwsh -NoProfile -NonInteractive -Command "[Console]::OutputEncoding.CodePage"` 得到 `936`，同一道命令前面接上那段指令得到 `65001`。因此那段指令本身就是字碼頁的決定者，不需要依賴 profile；拿掉這段指令屬於多餘的修改，不是修復。

`-NonInteractive` 的理由同樣是可量測的：少了這個參數，命令要求輸入帳號密碼時會跳出一個真的桌面視窗，把整次呼叫卡到被外部強制收掉。實測帶這個參數約 540 毫秒內就以錯誤結束，不帶則超過 8 秒仍在等待。

### 啟動參數不寫死

參數清單不寫死在擴充裡，每次呼叫時向 `getPowerShellConfig()` 取得，再過濾掉 `-NoProfile` 與 `-ExecutionPolicy`（連同 `-ExecutionPolicy` 的值）。上游日後增刪其他參數時擴充會跟著變，不需要同步修改；擴充不認得的旗標照樣傳遞。

### 命令的送出方式

把命令送進 pwsh 有兩種方式：當成 `-Command` 的參數值，或是在啟動後從 stdin 寫入。擴充採用前者，與內建版相同。stdin 餵法雖然能讓命令文字不出現在行程命令列上，但多行命令會被靜默吞掉：沒有輸出、離開碼 0，看起來像成功。實測之後判定不可用。

### 與內建版的比對結果

判定「與內建版一致」的方法是同一道命令分別經內建版與擴充送出，比對四項可觀察結果，而不是比對原始碼。同一輪的實測結果：

| 比對項目                                                      | 結果                               |
| ------------------------------------------------------------- | ---------------------------------- |
| `(Get-Process -Id $PID).CommandLine` 中 `-Command` 之後的字串 | 逐字相同                           |
| `Write-Output 漢字` 的輸出位元組                              | 完全相同（`e6 bc a2 e5 ad 97 …`） |
| `[Console]::OutputEncoding.WebName`                           | 相同（`utf-8`）                    |
| `exit 7` 的回傳離開碼                                         | 相同（7）                          |

結束判定的驗證數字，同一道命令分別經本擴充與內建版送出，各取三次的中位數（本機 zh-CN、pwsh 7.6.9、Node 26.13.0）：

| 命令 | 本擴充 | 內建版 |
|---|---|---|
| `Start-Process -NoNewWindow`（背景持有 15 秒） | 733 毫秒 | 670 毫秒 |
| `cmd /c start /b`（背景持有 12 秒） | 718 毫秒 | 636 毫秒 |

本擴充比內建版多 63 毫秒與 82 毫秒，上表的差額全部來自載入 profile：獨立量測 pwsh 啟動，不載入 profile 為 236 毫秒、載入 profile 為 334 毫秒，相差 98 毫秒；最直接的對照是同一道命令 `1`，本擴充中位數 443 毫秒、內建版中位數 341 毫秒，差 102 毫秒。上表兩個差額與這些值同一量級，差別屬於量測噪音。

這些差異的具體數值取決於使用者自己的 profile，不是擴充的固定成本：空 profile 幾乎不花時間，載入模組、主題或版本管理員的 profile 可能多出數百毫秒。同一個擴充在別的機器上會有不同差額；能通用的關係只有一項：差額等於同一台機器上載入 profile 的時間。

參數驗證的順序也必須與內建版相同：先驗逾時，再驗取消狀態，最後驗工作目錄。順序有實際後果，逾時上限就是其中一例：缺少 `MAX_TIMEOUT_MS = 2_147_483_647` 這道上限檢查時，`timeout: 3e9` 會讓 `setTimeout` 溢出成 1 毫秒，變成一個訊息誤導的假逾時。

### 上游改版時的失去同步

擴充從 pi 內建版複製了幾樣東西，因為套件入口沒有匯出。這些複本不會隨 pi 升級自動更新。`npm run test:pi` 會拿機器上實際安裝的 pi 逐項比對，並在每一項的結果裡印出比對到的版本；找不到 pi 套件時這些項目標記 SKIP 並說明原因，不會算成通過。

| 複本 | 取得方式 | 升級後會不會失去同步 | 由什麼發現 |
|---|---|---|---|
| 啟動參數清單 | 不複製：每次呼叫向 `getPowerShellConfig()` 取得 | 不會，pi 增刪其他參數時擴充自動跟上 | — |
| 命令的送出方式（command 接在參數清單的最後） | 假設，不是複本：直接讀取 pi 的參數清單，因此預設清單以 `-Command` 結尾 | 會。pi 改成從 stdin 餵命令時，清單結尾不再是 `-Command`，而擴充仍把命令接在最後一個參數後面 | 測試讀取 `POWERSHELL_ARGS`，確認最後一項是 `-Command` |
| 兩個旗標的名稱（`-NoProfile`、`-ExecutionPolicy`） | 寫在擴充裡的兩個常數 | 會。旗標改名，或 `-ExecutionPolicy` 改成自帶值的形式時，過濾什麼都濾不到，兩個旗標會被原樣送出，而且沒有任何錯誤訊息 | 測試讀取 pi 原始碼裡的 `POWERSHELL_ARGS`，確認兩個旗標還在，並確認過濾結果不含 `Bypass` |
| UTF-8 前綴字串 | 逐字複製 | 會。pi 改字串時擴充留舊字串；只要新舊字串都設成 UTF-8，行為就相同，執行結果看不出來 | 測試比對兩邊的常數字串，不一致時印出兩份內容 |
| 結束寬限與逾時上限（`EXIT_STDIO_GRACE_MS`、`MAX_TIMEOUT_MS`） | 複製數值 | 會。pi 調整其中一個時，擴充留舊值 | 測試比對兩邊的數值 |
| exec 的驗證順序、錯誤訊息、結束判定寫法 | 照內建版重寫 | 會。訊息或順序改變時擴充不會跟上，但這類差異大多只影響文字 | 沒有專門的上游比對；測試自己的斷言（逾時上限訊息、找不到工作目錄的訊息、取消與工作目錄的優先序）會在訊息或順序改變時失敗 |
| 工具註冊的方式（`createPowerShellTool(cwd, { operations })` 是否採用傳入的 `operations`） | 呼叫內建工廠 | 會。若 pi 不再採用傳入的 `operations`，覆蓋會無聲失效，兩個旗標回到命令列 | 測試用 pi 自己的工廠建立真的工具物件，執行一道命令後檢查命令列裡沒有那兩個旗標 |

比對用的 pi 從四個地方找：環境變數 `NPS_PI_ROOT`、`npm` 的 global prefix（在 `npm run` 之下由 `npm_config_global_prefix` 提供，另外試 `%APPDATA%\npm`）、Node 執行檔往上四層的 `node_modules` 與 `bin\node_modules`、專案自己的 `node_modules`。擴充本身沒有為了比對而增加執行期檢查；比對全部在測試裡，所以升級後必須跑一次測試才會知道有沒有失步。

這些比對失敗只代表「repo 裡的複本與機器上安裝的 pi 不一致」，不代表當下的 PowerShell 輸出錯了。實例：故意讓前綴字串多一個空白後跑測試，字碼頁仍然是 65001、中文輸出仍然正確，而字串比對仍然失敗。因此失敗訊息不會斷定「工具壞了」，只會指出哪一項不一致、以及是跟哪個版本比的。

### 已知差異

- **子行程 pid 登記簿**：內建版的 exec 程式會把每個子行程的 pid 記進 `trackDetachedChildPid`，pi 本體在收到 SIGTERM、SIGHUP 或崩潰清理時，透過 `killTrackedDetachedChildren` 一次結束登記簿裡的所有行程。這個登記簿與共用的 exec 程式同為 `utils/shell.js` 的內部狀態，套件入口沒有匯出，擴充掛不進去；自行處理訊號會與 pi 本體重複執行同一份清理工作，風險更高，所以不補。後果是 pi 本體在指令執行途中被訊號終止時，擴充啟動的行程樹不會被 pi 清理。逾時與取消兩條路徑不受影響，那兩條由擴充自己呼叫 `taskkill`，而且 `taskkill` 以 `detached: true` 啟動，可以在 pi 本體結束後繼續完成清理。
- **環境變數的預設值**：內建版在呼叫端沒有提供 `env` 時，會改用 `getShellEnv()`（這個函式會在 PATH 前面補上 `.pi/agent/bin`）。`getShellEnv` 沒有匯出，擴充只能原樣轉交呼叫端提供的 `env`。pi 本體一定會提供 `env`（`resolveSpawnContext` 會組好包含 `PI_*` 的環境變數），所以實際使用上沒有差別；差別只出現在 pi 本體之外直接呼叫擴充的情況，那時 PATH 的前置項目會少一層。
- **工具的建立選項**：內建工具接受 `exposeSessionEnvironment`、`spawnHook`、`commandPrefix` 三個選項，擴充只轉交 `operations`。pi 本體建立工具時不會傳入任何 `powershell` 選項（`dist` 裡只有 `options?.powershell` 的讀取端，沒有設定端），因此兩邊行為相同；若有外部程式用這些選項建立工具，擴充的覆蓋會忽略那些選項。
- **UTF-8 指令是一份字串複本**：內建版把那段指令放在私有常數 `UTF8_OUTPUT_PREFIX` 裡，套件入口沒有匯出，擴充只能複製字串。上游若改動那段指令，擴充不會自動跟上；測試只能驗證結果（字碼頁是 UTF-8），驗不到字串本身是否與上游一致。
- **工具的預設工作目錄**：擴充在載入時用 `process.cwd()` 建立工具，內建工具由 pi 用當下 session 的工作目錄建立。兩者在正常啟動（pi 在專案目錄裡啟動）完全相同；差別只出現在同一個 pi 程序內把 session 換到另一個工作目錄的情況（例如 `/resume`），那時擴充的預設工作目錄不會跟著換。

---

## 2. chat-trim-context（OpenCode 插件）

- **原始碼**：[`opencode/chat-trim-context/index.ts`](../opencode/chat-trim-context/index.ts)
- **測試**：[`opencode/tests/packaging/index.mjs`](../opencode/tests/packaging/index.mjs)、[`opencode/tests/chat-trim-context/index.mjs`](../opencode/tests/chat-trim-context/index.mjs)

### 成因

OpenCode 在 `chat` 模式下，每次送給模型的請求都附帶一段環境描述，佔用系統提示的空間，對是否能完成任務沒有幫助。

### 改寫範圍與條件

插件在啟動時向 OpenCode 註冊 `context`、`compaction`、`generate` 三個時機點的 hook，而且只處理 `chat` agent 的請求。

實際效果是模型收到的系統提示不再包含環境描述：以「Here is some useful information about the environment you are running in:」或「The environment you are running in is now:」開頭的段落會被移除，系統提示的其餘部分逐字不變；第一個區塊與非文字區塊一律原樣保留。

第一個區塊之所以一律保留，是因為 OpenCode v2.2.6 把模型身份描述寫在第一個區塊，而環境描述固定出現在第一個區塊後面的區塊。這個豁免條件依據的是 v2.2.6 的實際佈局，OpenCode 改版時需要重新確認。

改寫的方式是把 `event.system` 整個重新指派。條件是 OpenCode v2.2.6 在本體程式裡於 hook 執行完之後才讀取事件欄位，所以重新指派會生效；這個讀取順序由 v2.2.6 的程式碼佐證。

插件啟動時若 OpenCode 沒有提供 `ctx.session.hook` 這個註冊函式，插件就完全不註冊、不報錯、不動作。

---

## 3. pwsh-profile-loader（OpenCode 插件）

- **原始碼**：[`opencode/pwsh-profile-loader/index.ts`](../opencode/pwsh-profile-loader/index.ts)
- **測試**：[`opencode/tests/pwsh-profile-loader/index.mjs`](../opencode/tests/pwsh-profile-loader/index.mjs)
- **技術記錄**：[`docs/archive/PLAN.md`](archive/PLAN.md)（決策與量測日誌、計畫推演歷史）

### 成因

OpenCode 執行 shell 命令時固定加上 `-NoProfile`，所以平常開啟 pwsh 終端會自動完成的事（UTF-8 編碼、PATH 補上 git、python 虛擬環境自動啟用）在 OpenCode 的命令裡不會發生。

### 做法與條件

OpenCode 提供給插件的 shell 掛鉤是 `shell.create.before`：這個掛鉤拿到執行檔路徑與命令字串，只能改命令字串，改不到啟動參數。因此載入 profile 的方式只能是把載入程式碼接在命令前面。這段前綴（794 字元）照 pwsh 原生順序載入四個 profile 檔：AllUsersAllHosts、AllUsersCurrentHost、CurrentUserAllHosts、`$PROFILE`，載入完成之後才執行原本的命令。載入的內容與手動移除 `-NoProfile` 之後會載入的內容相同，命令的其餘部分逐字不變。

以下四項是實測確認的條件：

- profile 出錯不影響命令：錯誤以 pwsh 原生的格式出現在輸出裡，原本的命令照常執行。
- 同一道命令重複送達時，前綴不會疊加；四個 profile 檔全都不存在時，前綴什麼也不做。
- OpenCode 不需要執行 shell 就能判定命令的權限，而權限判定在改寫之前就以原始命令完成，因此不受前綴影響。
- 改寫一定生效：OpenCode v2.2.6 在 hook 執行完之後才讀取 `event.command`，hook 改過的內容就是實際執行的內容。

### 成本

每次命令增加 0 到 1 毫秒（解析 794 字元的前綴，加上三個檔案存在檢查），再加上執行使用者 profile 內容的時間（本機約 90 毫秒，同機另一次量測為 102 毫秒，兩者差別屬於量測噪音；實際值由 profile 內容決定，與插件無關）。系統上沒有部署物，也不需要編譯。

### 已知差異

- **profile 裡的 `exit` 會在原本的命令之前終止整個 pwsh**：前綴的 `catch` 只攔例外（`throw`），攔不到 `exit`。這個行為與手動開啟終端載入 profile 的原生語意一致，刻意不修。
- **profile 的標準輸出會進入每一道命令的工具輸出**：profile 印出的內容（例如 oh-my-posh 的初始化訊息）會出現在每一次 shell 工具結果裡，需要與目標指令自己的輸出分辨。這同樣是原生行為，保留。

---

# 測試

測試與插件資料夾分開放置，插件資料夾只包含交付物，因此手動安裝（`cp -r` 複製插件資料夾）不會把測試一起帶進安裝目錄。

## 現行設置測試

- **`pi-agent/tests/native-powershell/index.mjs`**（44 項檢查）：測試直接執行真的 pwsh，觀察 pwsh 實際如何被啟動、如何結束，不檢查原始碼寫了什麼。確認的項目如下：
  - 啟動參數：`-NonInteractive` 與那段 UTF-8 指令都在，`-NoProfile`、`-ExecutionPolicy`、`Bypass` 都不在；命令列與「直接用同樣參數啟動 pwsh」的結果一致。
  - 參數過濾的單元檢查：從內建版的五個參數過濾後只剩 `-NonInteractive -Command`；擴充不認得的參數照樣保留。這兩項不需要 pwsh，任何機器都會執行。
  - 命令的離開碼原樣回傳；呼叫端提供的 `env` 會傳進子行程。
  - 背景子行程持有繼承的輸出管道時仍在一秒內返回，測試涵蓋 `Start-Process -NoNewWindow` 與 `cmd /c start /b` 兩種寫法。
  - 逾時與取消的驗證順序、上限與錯誤訊息都與內建版一致；工作目錄不存在時會回報錯誤。
  - 命令要求輸入時（`$Host.UI.PromptForChoice`、`Get-Credential`、`Read-Host` 三種），立刻以錯誤結束，不會卡住等待。
  - 包裝檢查：`pi.extensions` 指向的檔案存在，而且 `package.json` 沒有任何依賴欄位，安裝時不會額外下載套件。
  - 編碼：字碼頁是 65001，中文輸出正確。這兩項看的是那段 UTF-8 指令的效果，不依賴 profile，因此不需要環境前提。
  - 上游比對：拿機器上實際安裝的 pi 比對擴充複製的內容。執行面的一項用 pi 自己的 `createPowerShellTool` 建立真的工具物件、執行真實命令，確認子行程的命令列裡沒有那兩個旗標、字碼頁是 65001、非 ASCII 輸出原樣返回、非零離開碼照實回報；文字面則直接讀 pi 的 `dist`，比對 `POWERSHELL_ARGS`（包含結尾是不是 `-Command`）、`UTF8_OUTPUT_PREFIX`、`EXIT_STDIO_GRACE_MS`、`MAX_TIMEOUT_MS` 與擴充的複本是否一致。比對會在每一項結果裡附上 pi 的版本；找不到 pi 套件時（可用 `NPS_PI_ROOT` 指定）這些項目標記 SKIP。
  - 沒有安裝 PowerShell 時，工具仍會註冊，`exec` 以內建版的錯誤訊息失敗。
  - 找不到任何 PowerShell 執行檔時，所有需要真的執行 pwsh 的項目一律標記 SKIP。輸出會分開統計 `passed`、`skipped`、`failed` 三個數字，跳過的項目不會被算成通過。
- **`opencode/tests/packaging/index.mjs`**（22 項檢查）：發布前的完整性檢查，分成 `package.json` 與插件程式碼兩個部分。
  - `package.json` 部分：插件不宣告任何依賴欄位（npm 安裝插件時不會自動下載大量套件）、`main` 指向的檔案確實存在、名稱以 `opencode-` 開頭。
  - 插件程式碼部分：不從 `@opencode/plugin` 匯入任何東西。兩個插件唯一用到的 OpenCode 介面只有 `define` 一個函式，而 `define` 實際上只是把傳入的插件原樣回傳（順便標註型別），因此在插件檔案裡自行宣告一個相同行為的函式就夠了。真的去匯入的話，npm 安裝插件時會把 OpenCode 整套相依套件一起抓下來（實測一次安裝多下載 273 個套件、168 MB）；改為本地宣告之後，每次安裝只多出插件本身 1 個套件、42 KB。
  - 匯出的插件物件要有 `id` 與 `setup` 兩個欄位。插件程式碼部分的檢查，載入測試也會查到（載入測試會真的把插件匯入執行，缺任何一項都會失敗）；`package.json` 的部分只有 packaging 檢查會查。
- **`opencode/tests/chat-trim-context/index.mjs`**（30 項檢查）：測試不經過 OpenCode，直接以 Node 載入插件原始碼並執行 `setup()`。
  - 傳入的插件環境只會把 `setup()` 註冊的 hook 函式記錄下來，測試確認三個時機點（`context`、`compaction`、`generate`）都有註冊；若 OpenCode 根本沒有提供這個註冊函式，`setup()` 也要正常返回，而且不註冊任何 hook。
  - 接著直接呼叫記錄下來的三個 hook 函式（三個時機點各跑一次同一組檢查），傳入預先準備好的系統提示內容，比對插件改寫後的結果：以兩句環境開頭組成的段落，無論獨佔一個區塊、夾在其他段落中間，或後面只剩空白，都會被移除；其餘段落逐字不變；第一個區塊與非文字區塊一律原樣保留；非 `chat` agent 完全不碰；不含環境段落的系統提示逐字不變。
  - 兩句環境開頭字串本身也在檢查之列：測試會逐字比對插件原始碼，一字之差就失敗。OpenCode 日後修改這兩句時，測試會提醒重新確認。
- **`opencode/tests/pwsh-profile-loader/index.mjs`**（20 項檢查）：測試只看插件實際執行的結果，不看原始碼寫了什麼，分兩層進行。
  - 第一層把插件真的載入進來、執行一次 hook，觀察插件改寫了什麼：pwsh 與 powershell 的命令要加上前綴，bash 不動，命令不是字串或只有空白時不動，命令裡已經有載入程式碼時不再加一次，四個 profile 檔都會逐一確認之後才載入，其中一個載入出錯時用 pwsh 原生的錯誤格式回報，OpenCode 沒有提供這個 hook 時整個插件不動作。
  - 第二層拿改寫出來的前綴真的去執行 pwsh，證明前綴確實載入 profile 且不干擾原本的命令。「確實載入」的證據是把環境裡的 git 從 PATH 移除，再由 profile 加回來。另外確認離開碼原樣回傳、四個 profile 檔全都不存在時前綴什麼也不做、profile 出錯時錯誤以 pwsh 原生格式出現在 stderr 且命令照常執行、profile 裡定義的變數與函式在命令中都取用得到。

執行現行測試：

```bash
npm run test:pi   # pi 擴充：native-powershell（44 項）
npm run test:oc   # OpenCode 插件：packaging（22 項）＋ chat-trim-context（30 項）＋ pwsh-profile-loader（20 項）
```

執行環境需求：Node.js 22.6 以上。測試與設置都靠 Node 內建的 TypeScript 型別剝離功能直接執行，不需要編譯。

## 封存設置測試

封存的測試套件（五套回歸測試，加上已退役方案 `pwsh-profile-shim` 的 11 項測試）以及用 Node 直接執行的方式，記載在 [`archive/README.md`](../archive/README.md)。

---

# 封存設置歷史技術規格

舊版環境修復層（`pi-agent/env-guard`、`opencode/env-guard`）的完整歷史技術架構、設計判準與問題根因分析——包含 `MSYS_NO_PATHCONV` 閘門、temp 掛載點、使用統計分類，以及「只能靠寫對的情境」與「未修復問題記錄」——全部留存於 [`docs/archive/spec-old.md`](archive/spec-old.md)。
