# 技術規格（舊版封存 / Historical Spec）

> **封存說明**：本文件為舊版環境修復層（包含 `cmdc-mods` 全系列、`pi-extensions/env-guard`、`oc-plugins/env-guard`）之完整歷史技術規格書存檔。
> 專案在 Windows 環境下已經全面轉向原生 PowerShell（PWSH），不再使用 Bash。現行模組技術規格請參閱 [`docs/spec.md`](../spec.md)。

---

# 技術規格（舊版詳細規格）

使用者須知（修復項目、輸出變化、設定方式與統計查看）請參閱根目錄
[`README.md`](../README.md)；本文件記載舊版的**技術架構、設計判準與實測證據**。通用判準
（原生執行優先、修復審查清單、驗證紀律）請參閱 [`AGENTS.md`](../AGENTS.md)，此處不重複。

三個 host 各自的實作演進：
- **cmdc**（已封存）：保留輸入側的 bash 語法掃描器。
- **pi 與 OpenCode (oc)**：兩者都已**整體移除指令字串的輸入側掃描改寫**；且**所有文字提示功能（包含 cmd 互動模式的 banner 提示訊息、以及 envp 系統提示詞）均已全數移除**。
  - 移除提示的理由：純靠 AI 自行判斷或閱讀建議文字的修復方式，無法進行機械化驗證，效果存在機率性失效。因此外掛不再提供任何 advisory 提示或系統提示詞，修復範圍純粹限縮在「位置固定、語意封閉」的輸入側路徑改寫（例如檔案工具的 temp 路徑）。
- **適用性按 host 獨立驗證**：同一顆 bash 在不同 host 的執行層下，同一個問題可能存在、也可能已被 host 自身處理（例如：磁碟代號路徑 `/c/...` 在 pi 由 host 的解析層自動正規化、在 OpenCode 由工具層處理；重導向 `> nul` 則是 bash 原生行為，重測後兩個 host 都一樣會在工作目錄建立實體檔案，結論都是「不修復」，但理由各自經過實測量測）。

---

# env-guard

## cmdc 版：路由架構

透過單一 hook，在每次指令呼叫時進行決策。

路由處理時進行的語意轉換：
- cmd 內建指令（`dir`、`copy`、`del`、`rd`、`set`、`ren`、`type`、簡單 `if`、`for`、`mklink`）。
- 變數與狀態碼：`%VAR%` → `$VAR`、`%ERRORLEVEL%` → `$?`。
- 路徑反斜線：`C:\a\b` → `C:/a/b`。
- 重導向：`2>&1` 原樣保留；cmd 的連續執行 `a & b` → bash `a ; b`（依序執行而非放到背景）；`2>nul` / `>nul` / `<nul` → `/dev/null`。
- bash 語法保護：`for i in …; do …; done` 與 `if …; then …; fi`（段首 `do`、`done`、`then`、`fi` 視為 bash 語法特徵），整行原樣交給 bash 執行。
- `bash -c '…'` 的 payload 包含 cmd 特殊字元（`"`、`%`、`$(`、反引號、`<>|&`，cmd 不支援單引號跳脫）時，改為輸出至暫存腳本執行；乾淨的 payload 則維持 inline 執行。

### 執行效果與輸出變化

| 項目                                                 | 變化                                                 |
| :--------------------------------------------------- | :--------------------------------------------------- |
| 中文檔名、`echo` 中文、程式輸出的中文（純 cmd 指令） | 正常顯示不亂碼                                       |
| 工具自身輸出的訊息標頭                               | 轉為英文顯示，例如 `Volume in drive C has no label.` |
| Unix 工具在 Windows 環境下呼叫                       | 直接可用                                             |

指令原始語意維持不變：`&&`、`|`、`>`、`%VAR%`、引號規則與離開碼（exit code）均與原生 `cmd` 一致。

### 效能成本

- 路由至 bash 的指令：啟動時間約增加 50 ms。
- 被包裝的純 cmd 指令：啟動時間約增加 **120 ms**（PowerShell 啟動耗時）。
- 輸出本身就是 UTF-8 的工具則直接跳過包裝，不增加耗時。

### 已知缺口與限制

| 缺口                                    | 說明                                                                                                                                                               |
| :-------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由指令內的 `cmd //c` 中文輸出可能亂碼 | 內層 cmd 的 GBK 編碼未經外層包裝；混合指令的中文原本就不在修復範圍。                                                                                               |
| 純 cmd 指令長度超過 1800 字元不進行包裝 | 受限於 Windows 命令列長度限制；路由指令另有 7000 字元上限。                                                                                                        |
| 涵蓋範圍                                | 僅處理 shell 語意的三個工具（`shell_command`、`powershell`、`monitor_command` 單字串形式走同一套路由；參數分開傳遞的形式原生正確，不需改動）加上檔案六件套的路徑。 |
| Python < 3.15                           | Python 3.15 起預設使用 UTF-8；舊版本需自行設定環境變數 `set "PYTHONIOENCODING=utf-8" &&`。                                                                         |

---

## pi 版：機制

pi 直接 spawn bash。在移除所有指令字串掃描與文字提示功能後，僅保留**單一確定位置的路徑修復**：

1. **檔案工具 temp 路徑（輸入側）**：
   在 `write`、`edit`、`read`、`grep`、`find`、`ls` 的 `path` 欄位中，將 `/tmp`、`$TEMP`／`$TMP`／`$TMPDIR`、`${TEMP}` 與 `%TEMP%`／`%TMP%` 改寫為由實際 bash 執行 `cygpath -w /tmp` 所取得的真實 Windows 路徑錨點。
   若探測失敗則不改動；至於 `/c/...`、`C:\tmp`、`~/x`、`nul` 則完全交給 pi 原生邏輯處理。
2. **無任何提示功能**：
   已整體移除過去嘗試過的輸出側 cmd banner advisory 提示與 envp 系統提示詞。外掛不再向模型注入任何文字建議或提示訊息。

**探測對象與 spawn 對象嚴格一致**：
pi 的 shell 決定方式為 `getShellConfig(settings.shellPath)`，外掛呼叫同一個函式，不自製 PATH 搜尋。以 `uname -s` 驗證 MSYS 環境身分，非 MSYS 或探測失敗時便停用相關修復。`MSYS_NO_PATHCONV` 透過實際啟動子 bash（帶入 `BASH_ENV`）進行探測並快取。

**BASH_ENV 探針細節**：
互動式 bash 的 `.bashrc` 設定對於非互動式 `bash -c` 不一定可見；本機設定是透過 `BASH_ENV` 讓子 bash 載入，因此探針必須以實際 spawn 子 bash 看到的值為準，而非單純讀取靜態設定檔。

pi bash 的執行結果形狀（參考 `dist/core/tools/bash.js`）：`content:[{type:"text",text:...}]`、`structuredContent.exit_code`、`isError`。統計維持 schema 1、儲存於 `env-guard-stats.json`，修復計數鍵為 `path.tempMount`、`path.tempVar`。

### redesign 2026-11-04（放棄輸入側指令掃描）

輸入側的 bash lexer 是開放集合：外部 wrapper、引號巢狀、重導向與 bash 複雜語法會不斷產生新形態。歷史提交紀錄顯示其維護成本極高，且一旦誤修就會靜默破壞正確語法。因此徹底捨棄輸入側指令改寫，改為只處理宿主 API 封閉的檔案路徑欄位。

---

## 刻意不修與未修復問題的判準

分類判準：
- **刻意不修（原生行為或模型本身寫錯）**：工具的回傳結果與原生環境一致。模型收到的是真實的系統錯誤訊息，能夠據此自我修正。
- **未修復問題（環境轉換層造成、工具回傳≠原生）**：不論終端是明確報錯還是靜默失敗，本質上都屬於環境問題。但若靜態修復需要對開放集合進行猜測，依據「寧可漏修，絕不誤修」的原則，一律不加入脆弱的改寫補丁，保留在已知問題清單中。
- **不依賴任何文字提示**：外掛不提供 advisory 或系統提示詞，純靠模型閱讀文字的修復方式已被全面廢棄。

### A. 刻意不修（回傳與原生環境完全一致）

- `C:\tmp`：Windows 原生寫入合法且成功。
- **MSYS 磁碟代號路徑 `/c/...`**：pi 檔案工具的解析層內建 `normalizeWindowsShellPath`，原生即可正確映射 `/c/Users/x` → `C:\Users\x`（包含 `/mnt/d`、`/cygdrive/e`），實測無路徑錯位。
- `>nul` / `2>nul` / `&>nul` / `"nul"`：在原生 bash 下（無論轉換開關與否），均會在工作目錄建立實體的 `nul` 檔案。bash 的標準丟棄裝置是 `/dev/null`，寫 `>nul` 是模型混淆了 cmd 語法所致，屬於原生行為，不予介入。write 工具 `path: "nul"` 亦同。
- `<nul`：bash 直接回報 `ENOENT`；`2>&nul` / `<&nul` 回報 `ambiguous redirect`，明確報錯且不產生檔案。
- 重導向目標的雙斜線（`cmd //c "x" > //out`）：目標路徑由 bash 自行開檔解析，不經由 argv 轉換層，原生就會明確報錯 `//out: Is a directory`。不應介入改寫成其他路徑，以免產生非預期的寫入。
- **UNC 路徑形態**（`cmd //server/share`）：`//alpha/beta` 是 UNC 路徑，MSYS 不轉換，cmd 視為無效開關。原生與改寫結果完全一致，均進入互動模式，無可修復差異。
- 原生即錯誤的 cmd 雙斜線語法（`cmd //?`、`cmd ///c`）：在轉換開啟時原生一樣出錯，屬於模型自己寫錯。
- **緊貼形態 `cmd//c` / `cmd//k` / `"cmd"//c`**：bash 將 `cmd//c` 視為單一程式名稱而非指令加參數，原生報錯 `No such file or directory` (exit 127)。插入空格將詞拆開等於替模型改錯字，缺乏環境故障點支撐，不修。
- 複合指令與前綴賦值（`command X=/c/x node`、`exec X=/c/x …`、`builtin X=/c/x …`）：這些關鍵字後接的是參數，bash 將 `X=/c/x` 當成指令執行，原生即報錯退出 (exit 127/1)。
- **引號內的偽前綴賦值（`A=/c/x "B=/c/y" node`）**：bash 的賦值前綴判定在引號移除之前，引號詞會被視為指令名稱，原生報錯 `No such file or directory` (exit 127)。
- 尾隨斜線的 temp 路徑（`path: "/tmp/"` → `…\Temp\`）：Windows API 對尾隨分隔符語意等價，保留原樣。
- 其他 cmd-ism（`del`、`dir /b` 等）：`del` 在 MSYS 下不存在，回傳 `command not found` 是 bash 原生訊息；`dir /b` 回傳參數錯誤亦屬原生行為。

### B. 未修復問題（環境轉換層造成，但靜態難以安全判定）

以下情況雖然屬於環境轉換層造成的異常（工具回傳≠原生環境），但由於安全修復需要預判開放集合的語法，依原則保留記錄而不強行修復：

- **原生物件帶斜線旗標（`taskkill //IM`、`net`、`reg`、`robocopy //mir`、`findstr //n`）**：
  在 `MSYS_NO_PATHCONV=1` 下雙斜線不會被轉換，工具收到字面 `//IM` 回報無效參數；而在 `=0` 下單斜線 `/IM` 又會被誤轉為路徑。要精確修復必須列舉所有吃 `/` 旗標的 Windows 原生工具，屬於開放集合。
- **外部 Wrapper 後的指令（`timeout 5 cmd //c`、`xargs cmd //c`、`nice …`）**：
  Wrapper 的參數結構屬於開放集合，外掛無法靜態得知哪個參數才是真正要執行的指令。
- **原生 exe 的 POSIX 路徑參數（`python /tmp/x.py`、`git -F /tmp/x`）**：
  在 `MSYS_NO_PATHCONV=1` 下原生程式收到字面 `/tmp/...` 會找不到檔案。要判斷哪個參數是檔案路徑需要理解個別程式的參數語意；若全面改寫 argv 則會破壞正規表達式或普通字串參數（如 `grep /tmp`、`sed 's|/tmp|X|'`）。
- **反斜線換行續接（`cmd \`⟨newline⟩`//c ver`）**：
  跳脫換行在不同語法上下文（引號內、Heredoc 標頭）語意各異，靜態難以安全改寫。
- **指令字串中成對反斜線被 `-c` 吞掉一層**：
  這是 Windows 上 git-bash 對 `-c` 參數的引號處理特性（WSL bash 則全部保留）。傳輸通道由 host 決定，外掛層看不到原始字串，強行加倍反斜線會破壞合法的換行或跳脫字元。如需確保位元組完全精準，應將內容先寫入檔案再執行。

---

## 只能靠「寫對」的語法總表（無法修復／刻意不修清單）

以下整理外掛不會改寫的情境，Agent 遇到時應直接採用原生推薦寫法：

| 情境形態                                    | 原生與實測行為                                       | 正確建議寫法                                                             |
| :------------------------------------------ | :--------------------------------------------------- | :----------------------------------------------------------------------- |
| `C:\tmp`                                    | 原生寫入成功（合法 Windows 路徑）                    | 若需要真實暫存目錄，請寫 `/tmp` 或 `$TEMP`（檔案工具會改寫）             |
| `~/x`                                       | Host 原生自動展開為家目錄                            | 正常撰寫即可                                                             |
| `/c/Users/x`（檔案工具 `path`）             | Host 原生自動映射為 `C:\Users\x`                     | 正常撰寫即可                                                             |
| `>nul` / `2>nul` / `<nul`                   | bash 原生行為：在工作目錄建立實體 `nul` 檔案或報錯   | 丟棄輸出請寫 `/dev/null`                                                 |
| 重導向目標為 `//x`（`cmd //c x > //out`）   | 由 bash 自行開檔，回報 `//out: Is a directory`       | 重導向請指定正常的檔案路徑                                               |
| 緊貼形態 `cmd//c`、`cmd//k`                 | 原生報錯 `No such file or directory` (exit 127)      | 程式名稱與旗標之間必須保留空格（如 `cmd /c`）                            |
| 前綴賦值接保留字（`command X=/c/x node`）   | 原生 exit 127：bash 將賦值當成指令名稱               | 賦值前綴請直接接真實執行程式                                             |
| 未加引號的 Windows 反斜線路徑               | 反斜線會被 bash 剖析器當作跳脫字元吞掉               | 請使用正斜線 POSIX 路徑，或加上雙引號（`"C:\Windows\System32\cmd.exe"`） |
| 原生工具旗標（`taskkill //IM`）             | `MSYS_NO_PATHCONV=1` 下雙斜線不會被轉成單斜線        | 請直接使用單斜線旗標：`taskkill /IM ...`                                 |
| 給原生 exe 的暫存路徑（`python /tmp/x.py`） | 原生 exe 無法辨識 `/tmp`                             | 給原生程式的路徑請寫 Windows 形式（`C:/...`）或先透過 `cygpath -w` 轉換  |
| cmd 輸出 GBK 亂碼                           | cmd 預設輸出字碼頁為 GBK，Host 以 UTF-8 解碼造成亂碼 | 建議改用 bash 原生工具（`ls`、`grep`、`find`）完成同等任務               |

---

## oc 版：安裝形態與打包體積

`opencode plugin add` 會下載套件並於安裝目錄執行 `npm install`。因此套件大小與依賴完全取決於插件的 `package.json`：
- 若宣告 `dependencies` 或 `peerDependencies`，npm 會下載整個依賴樹（例如宣告 `@opencode/plugin` 會下載 270+ 套件、占用約 168 MB）。
- 本專案規範**完全不宣告任何執行期依賴**：安裝目錄僅約 12 KB（`chat-trim-context`）至 48 KB（`env-guard`）。
- `Plugin.define` 僅是 identity 函式，插件可於本地自行宣告，不需引入外部執行期模組。
- `oc-plugins/tests/packaging/` 測試會嚴格檢查 package.json，確保零外部依賴與導出契約正確。

---

## oc 版：為什麼不再掃描指令，且移除所有提示功能

早期 oc 外掛曾包含約 600 行的 bash 語法剖析器（`scanBash` 等），試圖改寫指令字串。其後整體重構（redesign）：

1. **移除誤修母體**：指令字串（`event.command`）完全不再進行改寫。既然沒有改寫器，就徹底排除了「誤傷正確語法」的可能。
2. **全面廢除提示功能（2026-11-07）**：
   - 早期曾在輸出側提供 cmd banner 的 advisory 提示，以及注入 envp 系統提示詞。
   - **全面移除理由**：純靠文字提示引導 AI 自行修正，本質上依賴模型的自覺跟從，無法以機械化測試保證效果，存在機率性失效。與《[AGENTS.md](../AGENTS.md)》的「每項修復必須對應具體故障點且具備確定性機制」原則相違背。
   - 關於 `cmd /c` 與 `cmd //c` 的修復，已由 `docs/bash-vs-pwsh.md` 所述的 bashrc `cmd()` 函式（在 argv 層級進行機械轉換）取代。
3. **僅保留封閉 API 欄位的路徑修復**：
   僅在宿主 API 欄位語意完全明確的四個封閉介面上進行 temp 路徑替換：
   - `read` / `write` / `edit` / `glob` / `grep` 的 `path` 欄位。
   - `glob` 的 `pattern` 內嵌 temp 前綴（無指定 `path` 時拆分）。
   - `patch` 的 `patchText` 檔案指令行（`*** Add File:` 等）。
   - `shell` 的 `workdir` 欄位。

---

## oc 版：接線與閘門

插件僅註冊兩個必要 Hook，指令字串（`event.command`）始終維持唯讀：

- **路徑改寫（輸入側、封閉集合）**：`ctx.tool.hook("execute.before")` 針對 `event.input` 中的 `path`、`patchText` 與 `glob` 進行安全替換。
- **指令與工作目錄（唯讀與 workdir 改寫）**：`ctx.shell.hook("create.before")` 執行身分驗證（檢查 `event.shell` 是否為 MSYS bash）並改寫 `event.cwd`（未解析的 workdir）。`event.command` 絕對不變。
- **提示類 Hook 全數移除**：`tool.execute.after`（banner 提示）與 `ctx.session.hook`（系統提示詞注入）已全數刪除，不再註冊。
- **temp 錨點查詢**：向 bash 自身詢問真實路徑（`cygpath -w /tmp`），探測不到時改寫機制保持靜默（inert），不盲目猜測目錄結構。

---

## 使用統計（實作）

量測外掛在真實環境中的呼叫次數（分母 `toolCalls`）與各項修復觸發次數（分子 `fixes`）。
分類鍵定義標準為 **操作介面 (surface) × 故障機制**：

| 統計鍵 (Key)                                        | 觸發點               | 說明                                                        |
| :-------------------------------------------------- | :------------------- | :---------------------------------------------------------- |
| `path.tempMount` / `path.tempVar`                   | 檔案工具 `path` 欄位 | 分別統計 `/tmp` 掛載未映射與 `$TEMP` 變數未展開兩種不同機制 |
| `glob.tempMount` / `glob.tempVar`                   | glob pattern 前綴    | 同上機制                                                    |
| `patch.tempMount` / `patch.tempVar`                 | patch 指令行         | 同上機制                                                    |
| `shell.workdir.tempMount` / `shell.workdir.tempVar` | shell `workdir`      | 同上機制                                                    |

- 分子（修復觸發）即時寫入儲存。
- 分母（工具呼叫）在記憶體累加並透過 5 秒 debounce 定時寫入。
- 儲存設計：OpenCode 走官方 `ctx.storage`（儲存於 SQLite kv 表），pi 儲存於官方 agent 目錄之 `env-guard-stats.json`，均具備處理並發讀寫與合併的機制。

---

## oc 版：實測記錄（v2.2.5）

在 OpenCode v2.2.5 乾淨工作階段中，模型送出原始輸入與外掛處理後的實際寫入位置對照：

| 工具  | 模型原始輸入                          | 實際寫入位置與結果                                                          |
| :---- | :------------------------------------ | :-------------------------------------------------------------------------- |
| write | `path: $TEMP/oc-g2.txt`               | 正確寫入真實 `C:\Users\artin\AppData\Local\Temp`，專案下無字面 `$TEMP` 目錄 |
| write | `path: ${TEMP}/oc-g4.txt`             | 同上（大括號變數形式亦正確改寫）                                            |
| write | `path: $TMPDIR/oc-g8.txt`             | 同上                                                                        |
| write | `path: ~/oc-g6.txt`                   | `C:/Users/artin/oc-g6.txt`（Host 原生支援 `~` 展開，外掛不動）              |
| read  | `path: /tmp`                          | 正確列出真實 temp 目錄項目                                                  |
| glob  | `pattern: ${TEMP}/*.txt`（未給 path） | 修正前回傳 0 筆，修正後成功列出真實 temp 中的 txt 檔案                      |
| patch | `*** Add File: ${TEMP}/oc-g9.txt`     | 修正前在專案目錄建立字面 `${TEMP}` 資料夾，修正後正確落在真實 temp 目錄     |
| shell | `workdir: /tmp`、`command: pwd`       | 修正前報錯找不到目錄 `C:\tmp`，修正後 `pwd` 正常輸出 `/tmp`                 |

---

# system-prompt (cmdc)

透過專案或全域目錄下的檔案自訂提示詞，檔案存在即生效：
- `SYSTEM.md`：整份取代內建系統提示詞。
- `APPEND_SYSTEM.md`：附加在內建提示詞之後。

每次呼叫均動態讀取，刪除檔案即可立即恢復預設值。

---

# disable-tools (cmdc)

透過 Host 的 `setActiveTools` filter，將不需要的工具完全從 Model Schema 中排除：
- 被列名之工具的 schema 不會發送給模型，且執行期直接拒絕。
- session 開始與每次 `run_start` 時重新套用，避免干擾其他模組。

---

# chat-trim-context (oc)

針對 OpenCode 的 `chat` agent，在每次送出請求前（`context`、`compaction`、`generate`）自動清理系統提示詞：
- 移除 `<env>...</env>` 環境資訊段落。
- 移除包含 worktree marker（`tools.opencode.session_move`）的段落，有效節省對話 Context 空間。

---

# 測試架構

測試程式碼一律置於各 Host 資料夾的 `tests/` 目錄下，與外掛交付目錄嚴格分離：

- **單元測試套件**：直接以 Node 原生執行 TypeScript（利用 Type Stripping），無需建置步驟。
- **打包體積檢查**（`oc-plugins/tests/packaging/index.mjs`）：嚴格檢查無外部依賴、無 host 執行期引用，確保安裝輕量。
- **斷言防回歸**：針對每項路徑改寫規則、刻意不修情境、Hook 契約防護與統計持久化邏輯均包含完整單元測試。
