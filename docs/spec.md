# 技術規格（spec）

使用者須知（修了什麼、會看到什麼、怎麼設定、怎麼看統計）在根目錄
[`README.md`](../README.md)；這份記**技術架構、設計判準與實測證據**。通用判準
（原生執行優先、修復審查清單、驗證紀律）見 [`AGENTS.md`](../AGENTS.md)，此處不重複。

三個 host 各自實作：cmdc（封存）保留同源的輸入側 bash 掃描器；pi 與 oc 都已
**整體移除指令字串的輸入側掃描改寫**，改為輸出側偵測——理由見 pi 版的
〈redesign 2026-11-04〉小節與 `docs/oc-env-guard-redesign.md`；現行機制：
pi 見〈pi 版：機制〉、oc 見〈oc 版：接線與閘門〉。但**每一條修復的「適用性」是在本 host 重新量過才留**：同一顆 bash 在不同 host 的
執行層下，同一個病理可能存在、也可能被 host 自己的層攔掉（例：`/c/...` 在 pi
由 host 自己的解析層正規化、在 OpenCode 由工具層處理；`nul` 重導向是 bash 原生
行為，重測後兩個 host 都一樣會建實體檔——結論都是「不修」，但理由各自量過。
pi 版曾誤記「bash 把 nul 映射到丟棄裝置」，已按重測修正——這正是本段原則的
活例：文件裡的「實測」主張本身也會過期，要能被重測推翻）。

---

# env-guard

## cmdc 版：路由架構

一個 hook、每次呼叫一個決策點。README 的〈修復範圍〉表列每行指令的走法；這裡記
路由時順手做的翻譯與機制細節。

路由時順手翻譯：cmd 內建（`dir`/`copy`/`del`/`rd`/`set`/`ren`/`type`/simple `if`/`for`/`mklink`）、
`%VAR%`→`$VAR`、`%ERRORLEVEL%`→`$?`、`C:\a\b`→`C:/a/b`、`2>&1` 原樣保留、
cmd 的裸 `a & b` → bash `a ; b`（依序而非丟背景）、`2>nul`/`>nul`/`<nul` → `/dev/null`。
bash 語法的 `for i in …; do …; done` 與 `if …; then …; fi` 不誤判成 cmd（段首 `do`/`done`/`then`/`fi` 是 bash 鐵證），整行原樣交給 bash；
`bash -c '…'` 的 payload 帶 cmd 活字元（`"` `%` `$(` `` ` `` `<>|&`，cmd 不認單引號）時改送暫存腳本，乾淨 payload 維持 inline。

### 會看到什麼

| 項目                                                 | 變化                                           |
| ---------------------------------------------------- | ---------------------------------------------- |
| 中文檔名、`echo` 的中文、程式輸出的中文（純 cmd 行） | 正常顯示                                       |
| 工具自己的訊息標頭                                   | 變英文，例如 `Volume in drive C has no label.` |
| unix 指令在 Windows                                  | 直接可用                                       |

指令語意不變：`&&`、`\|`、`>`、`%VAR%`、引號、離開碼都跟原生 `cmd` 一致。

### 成本

路由行：bash 啟動約 +50 ms；被包裝的純 cmd 行：約 **+120 ms**（PowerShell 啟動）。UTF-8 工具跳過。

### 已知缺口

| 缺口                                | 說明                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由行內的 `cmd //c` 中文輸出會亂碼 | 內層 cmd 的 GBK 未經包裝；混合行的中文本來就沒修，路由不改這一點                                                                                   |
| 純 cmd 行超過 1800 字元不包裝       | Windows 命令列長度上限；路由行另有 7000 上限                                                                                                       |
| 覆蓋範圍                            | shell 語意的三個工具（`shell_command`、`powershell`、`monitor_command` 單字串形式走同一套路由；args 分開傳的形式原生正確，不動）＋檔案六件套的路徑 |
| Python < 3.15                       | 3.15 起預設 UTF-8；更舊的自行 `set "PYTHONIOENCODING=utf-8" &&`                                                                                    |

## pi 版：機制

pi 直接 spawn bash，env-guard 僅保留三個低風險機制：

1. **檔案工具 temp 路徑（輸入側）**：write/edit/read/grep/find/ls 的 `path` 欄位中，`/tmp`、`$TEMP`／`$TMP`／`$TMPDIR`、`${TEMP}` 族與 `%TEMP%`／`%TMP%` 改寫到由實際 bash 執行 `cygpath -w /tmp` 得到的錨點。探不到便不改；`/c/...`、`C:\tmp`、`~/x`、`nul` 仍交給 pi 原生處理。
2. **cmd 互動 banner（輸出側）**：僅 Windows 上檢查成功的 bash `tool_result`。指紋＝輸出前兩個非空行：第一行以 `Microsoft Windows [` 開頭、第二行以 `(c) Microsoft` 開頭（GBK 亂碼下兩個 ASCII 前綴都存活；提示符行 `X:\…>` 在管線 stdin 形態在、`/dev/null` stdin 形態不在，故**不**列入指紋；單獨的版本行是 `cmd /c ver` 的正常輸出，不命中）。命中時附加 `[env-guard]` advisory，指出原命令沒執行且 exit 0 不代表成功。按實際 MSYS 探針提示 `cmd /c <command>` 或 `cmd //c <command>`；以回傳 patch 傳播（`structuredContent` 原樣帶回）。截斷後辨識不到就放行。banner 經非 tty 管線也會輸出且 exit 0（本機實測）。
3. **envp 路徑（輸入側掃描已移除）**：不再改寫 bash 指令。僅在 Windows 且 `MSYS_NO_PATHCONV` 確實停用時，`before_agent_start` 加入一次純 ASCII 系統提示：前綴賦值路徑值寫 Windows 形（`VAR=C:/x`，`VAR=/c/x` 會被 native exe 當成磁碟相對路徑）；native exe 旗標用單斜線（`cmd /c`、`taskkill /IM`）。marker 保證同一 systemPrompt 不重複追加。

**探測對象≡spawn 對象**：pi 的 spawn 決策是 `getShellConfig(settings.shellPath)`，擴充呼叫同一函式；不自製 PATH 搜尋。`uname -s` 驗證 MSYS 身分，非 MSYS／探測失敗便停用相關功能。`getShellConfig` 自 pi 0.48.0 起才 export；舊宿主上探測失敗即 fail-safe。`MSYS_NO_PATHCONV` 透過實際子 bash（含 BASH_ENV）探測並快取。

**BASH_ENV 探針陷阱**：互動 bash 的 `.bashrc` 設定對非互動 `bash -c` 不必然可見；本機設定由 `BASH_ENV` 令子 bash 載入，因此探針以實際 spawn 子 bash 的值為準，而非讀取設定檔或假設預設值。

pi bash 結果形狀（實讀 `dist/core/tools/bash.js`）：`content:[{type:"text",text:...}]`、`structuredContent.exit_code`、`isError`；非零 exit 會標 `isError:true` 並附退出碼文字。插件接受上述形狀及字串 content，無可檢視文字則不動。統計維持 schema 1、`env-guard-stats.json`、merge/debounce/per-PID tmp/session_shutdown flush；fix keys 為 `path.tempMount`、`path.tempVar`、`shell.cmdBanner`，歷史鍵仍由 `adoptCounts` 保留。

### redesign 2026-11-04

輸入側 bash lexer 是開放集合：wrapper、引號、重導向與 bash 語法持續產生新形；過去六天五個 misfix commit 顯示其結構性審查成本，且誤修會靜默破壞正確語法。輸出側只在可辨識的成功互動 banner 後提示；誤判的失效模式是多一段 advisory、零執行破壞。辨識保守，截斷或不確定即漏過。

本文件的 pi 掃描器稽核段（零效應改寫稽核、兩輪重跑）隨掃描器一併移除，證據在 git 歷史（e5b415f 及其前）；oc 的對應稽核段與掃描器規則段同樣隨 oc redesign 整體移除（理由同源，見下），證據在 git 歷史。

**活體 e2e 與工具面**：pi 檔案工具 host 端解析 `/c/...`，不重複改寫；host 自己解析的路徑欄位只有 read/write/edit/grep/find/ls 的 `path`。bash 與 powershell 沒有 `workdir`，pi 沒有 patch/glob 內建工具；find `pattern` 與 grep `glob` 不屬於 path 修復面。

### 刻意不修與漏修的分界

分類判準：**刻意不修＝原生失敗——工具的回傳與原生相同**（agent 看到的是真實原因
、可自癒）；**環境轉換層造成的失敗（工具回傳≠原生）不論大聲或靜默都是漏修**——
大聲只是失敗的形態、不是不修的豁免；漏修留在臺帳，僅因每個靜態修法都需要開放集合
的猜測（以誤修風險為界：寧可漏修、不可誤修）。

**刻意不修（原生行為或模型自身錯誤，讓它壞）：**

> pi 與 oc 都已移除輸入側掃描（理由見 pi 版 redesign 小節；oc 的調整見
> `docs/oc-env-guard-redesign.md`）。**下列條目只記 bash 原生行為與 host 實測**
> ——條目只記 bash 原生行為與 host 實測。cmd 形的現行處置＝輸出側
> banner backstop：凡實際進入互動 banner 的形（wrapper／payload／續行／
> 重導向前綴／time／算術等邊界形）一律不改寫輸入、命中即附加 advisory；
> 輸出被截斷或指紋不完整則漏過；cmd 以外的 native exe 旗標與 envp 賦值不在
> 覆蓋範圍（oc 以一行系統提示導正 envp 值寫法，見 README）。

- `C:\tmp`——原生寫入會成功。
- **MSYS 盤符路徑 `/c/...`**——pi 的檔案工具解析層內建 `normalizeWindowsShellPath`
  原生正確映射 `/c/Users/x`→`C:\Users\x`（含 `/mnt/d`、`/cygdrive/e`），e2e 實測
  無 `C:\c` 錯位——盤符修復只在沒有這層正規化的 host 才合理。
- `>nul`/`2>nul`/`&>nul`/`"nul"`——重測（轉換開／關皆驗）：本機 bash 在 cwd 建
  出實體 nul 檔（Windows `dir` 可見、內容為重導向輸出），`rm nul` 可刪；舊記錄
  「bash 把 nul 映射到丟棄裝置、多數形態不建檔；僅同進程 /dev/null 共存時才建檔」
  不符現況（連 `> nul` 單獨存在也建）。不修判準不變：bash 原生行為、無環境層
  故障點——bash 的丟棄裝置是 `/dev/null`，寫 `>nul` 是模型 cmd-ism 自身錯誤。
  write 工具 `path:"nul"` 同理（Node host 端原生建真檔，實測 dir 可見）。
- `<nul`——bash 直接報 ENOENT；`2>&nul`/`<&nul`——ambiguous redirect，大聲失敗
  且不造檔（重測一致）。
- 重導向目標的雙斜線（`cmd //c "x" > //out`）——目標路徑是 bash 自己開檔時
  解析的，根本不經被 MSYS_NO_PATHCONV 關掉的 argv 轉換層——沒有故障點；原生
  就是大聲失敗（`//out: Is a directory`）。也不能「順手」修正：「修」成
  `/tmp/eg.log` 反而會靜默寫到另一個位置——這是誤修方向，目標原樣不動。
- **UNC 形**（`cmd //server/share`）——`//alpha/beta` 是 UNC 路徑，MSYS 不轉它、cmd 當無效
  switch：四種組合（原生／本機 × 原形／單斜線形）實測**全是互動
  banner**——原形與任何「改寫」都分不出結果差異，沒有可修的東西，不修。
  同族的 `cmd //c/d/e ver` native 兩態皆 banner（不修）。
- 原生就壞的 cmd 雙斜線形（`cmd //?`、`cmd ///c`）——
  實測轉換開啟時一樣進互動模式：模型自己寫錯，不修。
- **緊貼形 `cmd//c`／`cmd//k`／`"cmd"//c`**——bash 把 `cmd//c` 當**程式名**
  （不是 `cmd` 加旗標）：原生是 `bash: cmd//c: No such file or directory`、
  exit 127，兩種轉換狀態下逐位元相同（實測）。所以沒有環境故障點——改寫它
  不是修環境層，而是插一個空格把一個詞拆成兩個＝替模型改錯字。附帶量測更正：
  banner 是**轉換開啟**時 `/c` 被轉成 `C:/` 的病理；轉換關閉（gate ON）下
  `cmd /c ver` 實測就是直接跑 `ver`——兩個失效形態不會同時發生，所以
  backstop 偵測的是 banner、建議的是 gate ON 時的 `/c` 寫法（見 redesign 小節）。
- exec/command/builtin 後的賦值形（`command X=/c/x node`、`exec X=/c/x …`、
  `builtin X=/c/x …`）——這些詞後接的是參數：bash 把 `X=/c/x` 當指令名跑、
  原生就大聲失敗（實測 127／127／1、兩種轉換狀態同訊息）＝回傳≡原生，不修
  。`env X=/c/x node` 不同：env 是 POSIX 外部程式，X= 參數跨
  msys→native 邊界（實測原生在轉換開啟時轉 `C:/x`）——轉換關閉（gate ON）時
  值原樣抵達＝靜默錯位，屬漏修臺，由系統提示教 `VAR=C:/x` 寫法（不修輸入）。
- **引號詞裡的偽賦值形（`A=/c/x "B=/c/y" node`）**——bash 的賦值前綴判定在
  quote removal 之前，引號詞是**指令字**不是前綴（實測 `B=/c/y: No such file
  or directory`、127）＝原生失敗，不修。
- 尾隨分隔符形的 temp 路徑（`path: "/tmp/"` → `…\Temp\`）——Windows API 對
  尾分隔符等價（落點／錯誤形態都一樣），保留原樣輸出、不另外 strip：沒有
  故障點，不動。
- MSYS 磁碟路徑（`/c/Users/...`）——host 的工具層自己映射（pi：read／e2e 落點
  正確；oc：read v2.2.1、shell `workdir` v2.2.5 重測，落在正確目錄）；再改寫
  ＝重複防護、純副作用。
- 其他 cmd-ism（`del`、`dir /b`…）——`del` 真的不存在，"command not found"
  是 bash 自己的訊息（工具回傳≡原生）；`dir` 存在（/usr/bin/dir）但它是 MSYS
  程式（msys→msys 邊界不轉換），`/b` 兩種環境都原樣抵達、同樣 rc=2
  cannot access（實測逐位元相同）——模型從 cmd 帶來的寫法，不修。
  `robocopy //mir` 不在此列：robocopy 是 PATH 上的 Windows 二進位，與 taskkill
  同一故障、且失敗形態是卡死不是快敗 → 漏模臺帳（見該條實測）。

**漏修臺帳（環境轉換層造成、工具回傳≠原生；大聲≠豁免，留下的唯一理由＝靜態
修法是開放集合的猜測）：**

- / 前綴原生工具的雙斜線旗標（`taskkill //IM`、`net`、`reg`、
  `robocopy //mir`、`findstr //n`…；`sc //query` 不算這族——`/query` 本身就不是
  合法子命令（`sc query` 才是），實測兩態同結果＝模型錯字、歸刻意不修）——與 `cmd //c` 同一個故障點（四向實測：
  本機 `//IM` exit 1 報『無效參數』、本機 `/IM` 成功、原生 `//IM` 成功、原生
  `/IM` 被 argv 轉換改壞成 `C:/…/Git/IM` 而失敗）；事件實錄：拿掉遮罩後下一步
  就改 `/IM`（大聲自癒，但失敗來自轉換層＝漏修形態），靜態修復需列舉「哪些
  程式吃 / 旗標」＝開放集合 → 留在漏修臺。cmd 是唯一例外：失敗靜默（互動模式
  、exit 0）且是 OS shell → 已修。失敗形態隨程式而異，robocopy 最糟：本機
  `robocopy //xxx a b` 把 `//xxx` 當來源路徑、Windows 正規化成 UNC `\\xxx\`
  （bash argv 原樣傳 `//xxx`、實測；正規化在 robocopy 自己那一層），錯誤 161
  觸發它預設 `/R:1000000 /W:30` 重試迴圈＝無限卡；原生端 `//xxx`→`/xxx` 無效
  switch 快敗 rc=16（實測 64–79ms）——兩端發散。探測紀律：實測 robocopy 形必須
  `timeout` 包住＋`//r:1 //w:1` 給重試上界，`| head` 截斷救不了（head 退出後
  pipeline 仍在等 robocopy）。
- 外部 wrapper 後的 cmd（`timeout 5 cmd //c`、`xargs cmd //c`、`nice …`）——
  同一故障層；wrapper 參數結構是開放集合＋猜測。env/exec/command/builtin 已納入
  關鍵字（閉集合，見上）。
- **原生 exe 的 posix 路徑參數**（`python /tmp/x.py`、`git -F /tmp/x`）——
  `MSYS_NO_PATHCONV=1` 關掉了對原生程式 argv 的路徑轉換，原生 exe 收到字面
  `/tmp/...` 找不到檔（實測 `could not open`；MSYS 程式如 cat/ls 不受影響）；
  判斷「哪個參數是路徑」要各程式自己的參數語義＝開放集合，全面改寫 argv 又會
  改壞字串／regex（`echo /tmp`、`grep /tmp`、`sed 's|/tmp|X|'`）、誤傷依賴
  posix 形式的 MSYS 工具參數——誤修風險大於漏修。
- **範圍界定（為何只有 cmd 進了修復清單）**：吃 `-`/`--` 旗標的工具（git/npx/
  python/pwsh…）對 MSYS_NO_PATHCONV 沒有可觀察影響——msys argv 轉換層不碰
  `-` 開頭的參數，不是選擇性不修，是它們沒有這個故障模式。cmd 單獨納入的
  依據＝①故障在轉換層且模型語法無錯（`//c` 是 git-bash 官方慣用法）；②失敗
  靜默（互動模式、exit 0、橫幅偽裝成輸出）；③ OS shell（bash 到不了的 OS
  設施都得經它，e2e 實測自然觸發）。將來若有別的工具三條全中，再按同一標準
  納入。
## 只能靠「寫對」的形（pi / oc 共用；無法修復／刻意不修總表）

有些形插件**永遠不該或不能改寫**：唯一改善途徑是 agent 自己把指令寫成另一種
形式（或宿主層修）。判準沿用本檔開頭：**回傳≡原生 → 刻意不修（讓它壞，agent
看得到真原因）；回傳≠原生但靜態不可判定／治療點在權限外 → 無法修復（記臺帳）**。
每列的「實測」都是在這台機器上兩種轉換狀態各跑一次得到的；bash 原生行為與 host
實測仍然有效。現行外掛不再改寫指令字串（理由見 redesign 小節）：輸入側改寫只剩
四個閉集合 temp surface（`path`／`glob` 前綴／`patch` 指令行／shell `workdir`
，欄位語意被宿主 API 密封），cmd 形由 banner backstop 接住——表中「插件該怎麼
寫」欄因此是 agent 唯一能動的改良途徑，比以前更重要。

**A. 刻意不修（回傳≡原生：原生就壞，或 host 已經處理）**

| 形 | 實測 | agent 該怎麼寫 |
| --- | --- | --- |
| `C:\tmp` | 原生寫入成功（合法 Windows 路徑） | 要「真實 temp」就寫 `/tmp` 或 `$TEMP`（這兩個插件會改寫） |
| `~/x` | host 自己展開 | 照寫即可 |
| `/c/Users/x`（檔案工具 `path`） | pi／oc host 原生映射成 `C:\Users\x` | 照寫即可（不要再期待插件改） |
| `>nul`／`2>nul`／`<nul`／`2>&nul` | bash 原生：建實體 `nul` 檔／ENOENT／ambiguous redirect | 要丟棄輸出寫 `/dev/null` |
| 重導向目標的 `//x`（`cmd //c x > //out`） | 目標由 bash 自己開檔，`//out: Is a directory` | 目標寫正常路徑 |
| `cmd //?`、`cmd ///c ver`、`cmd //server/share`、`cmd //c/d/e ver` | 模型錯字。`///c` 兩態**輸出不同**：轉換開啟＝互動 banner、本機＝意外跑到 `ver`；都不改（修它＝替模型改錯字）。`//server/share` 四態全 banner；`//c/d/e` 同族（native 兩態皆 banner，無可修的差異） | 執行就寫 `cmd //c <cmd>`（使用 `cmd /c`；需轉換開啟的環境則為 `cmd //c`） |
| 緊貼形 `cmd//c`、`cmd//k`、`"cmd"//c`、`x=1 cmd//c` | 原生 127：bash 把 `cmd//c` 當**程式名** | 程式名與旗標之間要有空格 |
| `exec X=/c/x …`／`command X=/c/x …`／`builtin X=/c/x …` | 原生 127／127／1：bash 把 `X=/c/x` 當指令名跑 | 前綴賦值要直接接真指令字 |
| 引號偽賦值 `A=/c/x "B=/c/y" node` | 原生 127（`B=/c/y: No such file or directory`）：賦值判定在 quote removal 之前 | 同上；引號詞不是賦值前綴 |
| 未引號 Windows 路徑 `cmd.exe`（`C:\\Windows\\…\\cmd.exe`、`C:\Windows\…\cmd.exe`、`/c/Windows\…`） | **兩層轉換，host 相同**（2026-11-04 live 重測 oc）：transport 先把每對 `\\` 折一層（2→1、4→2），bash 未引號 lexer 再去一層跳脫。**1–2 個反斜線** → `C:Windows…`（程式不存在、127）；**3 個以上**（3/4 已實測）→ 真實的 `C:\Windows\…`（程式存在、會跑 cmd）。**引號**的 `"C:\Windows\…\cmd.exe"`／`"/c/Windows\…"` 在兩 host 都是字面分隔符、真的跑 cmd | 用全正斜線的 POSIX 路徑，或直接寫 `cmd`；要寫 Windows 路徑就加引號（兩 host 一致），或把反斜線加倍（3 個以上，3/4 已實測） |
| `del x`、`dir /b`、`sc /query …`、`reg query //?`、`findstr //?` | 兩態同結果（`del` 不存在、`dir /b` 是 MSYS `dir` 的非法參數、`sc` 的子命令是 `sc query` 不是 `/query`） | 用 bash 原生工具：`rm`、`ls`、`sc query` |
| `( … ) cmd //c …`、`{ …; } cmd //c …`、`if … fi cmd //c …`、`while … done cmd //c …`、`case … esac cmd //c …`、`f() cmd //c …` | 原生語法錯誤（exit 2）：複合指令／函式本體結束後沒有分隔符就接簡單指令（函式本體必須是複合指令） | 加 `;`／`&&`／換行 |
| `for x in cmd //c …`、`case … in … pattern` 這類 slot | list／pattern 是資料，不是指令（實測 `for x in cmd //c` 印 `[cmd] [//c]`） | 要執行就寫在 body／指令位置；插件永遠不會改寫資料位置 |

**B. 無法修復（回傳≠原生，但靜態不可判定／開放集合；記臺帳不補貼）**

| 形 | 為什麼不能修 | agent 該怎麼寫 |
| --- | --- | --- |
| 外部 wrapper：`timeout 5 cmd //c ver`、`xargs cmd //c ver`、`nice … cmd` | 要逐一建模「哪個參數才是被執行的指令」＝列舉工具（AGENTS 明文禁止）；實測轉換關閉時確實是 banner 靜默 | 把 `cmd //c …` 寫在**指令位置**，需要 wrapper 就包外層 |
| 引號 payload：`bash -c 'cmd //c ver'`、`env -i bash -c "…"`、`node -e '…'` | 「哪些程式把首參數當腳本」＝開放集合；改引號內容就是改資料 | 外層直接寫，或把腳本放檔案再執行 |
| `time -p cmd //c ver` | 保留字／指令的旗標何時結束指令位置＝開放集合（實測轉換關閉＝banner） | 不要加 `-p`，或把 `cmd //c` 寫在 `time` 直接後方 |
| `cmd \`⟨newline⟩`//c ver`（反斜線續接） | 詞法層可解，但跳脫對的上下文（引號內／heredoc 標頭）語意各異 → 依「寧可漏修」先記臺（實測轉換關閉＝banner） | 不要用續接寫旗標 |
| 原生工具旗標 `taskkill //IM x //F`（**實測 DIFF**） | `//flag` 在轉換開啟時被 MSYS 轉成 `/flag`；本機 gate ON 不轉 → 工具收到字面 `//IM`（無效參數）。哪個工具吃哪種斜線＝開放集合 | **gate ON 時寫單斜線**：`taskkill /IM …`（實測可用）；`//` 是給「轉換開啟」環境的寫法，兩者不能通用 |
| 原生 exe 的 POSIX 路徑參數 `python /tmp/x.py`、`git -F /tmp/x`（**實測 DIFF**：轉換開啟解析到真實 temp、本機落到 `C:\tmp`） | 「哪個參數是路徑」要各程式的參數語義；全面改寫 argv 會毀掉 `grep /tmp`、`sed 's|/tmp|X|'` 這類字串參數 | 給原生 exe 的路徑寫 Windows 形式（`C:/…`）或先 `cygpath -w` |
| envp 殘餘值形：引號值 `A="/c/x"`、根相對 `A=/usr/x`、清單 `A=/c/x:/d/y`、含 `\` 的值、動態頭 `A=$(echo /c/x)`、緊貼 `VAR=/c$(…)`、`env -u V X=/c/…`、`A=/c/x 2>&1 cmd` | 整值或參數語意靜態看不到（詳見〈envp 殘餘形〉） | 值直接寫盤符形式 `A=C:/x`；重導向／選項放到指令後面 |
| 函式名與其他 msys 程式（`A=/c/x git …`、`A=/c/x f`）的混合邊界 | 開放集合；原生「讀值」與「spawn 後代」兩側行為相反 | 需要轉換就直接寫 `C:/…` |
| `function f { … cmd //c …; }`（`function` 名稱槽後的本體） | 指令字串不重寫（redesign 判準）；未來若重開輸入側改寫，名稱槽與本體的判定要完整函式文法＝開放集合 | 用 `f() { …; }` 形式 |
| ANSI-C 指令字：`$'cmd' //c ver` | `$'...'` 的內容要 ANSI-C 解碼後才是指令名（`$'cmd'` → cmd，實測 native 跑 ver、轉換關閉＝banner）——改寫位置需完整解碼語意才能精確判定，不重寫；真進互動模式的由 banner 偵測接住 | 直接寫 `cmd //c …` |
| `coproc cmd //c ver` | `cmd` 落在 coproc 的參數位置；且 Windows 上 coproc 的管道行為本身也不穩定（實測錯誤訊息亂碼且與 native 不同）——為零頻率保留字加掃描狀態不值得 | 不要把 coproc 與 cmd 混用 |
| 重導向**前綴**後的 cmd：`> log cmd //c ver` | 這是合法 bash（重導向可前置，`cmd` 真的執行）；實測轉換關閉＝banner、native 跑 ver。靜態修法要追「本 simple command 是否已有指令字」（`echo x > log cmd //c` 的 cmd 是 echo 的參數）＝開放集合 | 重導向寫在指令後面：`cmd //c ver > log` |
| 重導向**前綴**後的 envp 賦值：`> log A=/c/x node` | 同上；實測 native 值轉成 `C:/x`（寫進 log 的 `process.env.A`），插件不改寫＝落回 `C:\c\x` 的靜默錯位 | 重導向寫在後面：`A=/c/x node > log` |
| `+=` 賦值前綴：`A+=/c/x node`、`A=/c/x A+=/tmp/y node` | native 轉換的是**每個變數的最終值**：`A+=/c/x` 的首值可轉，但同一 simple command 先有 `A=/c/x` 時，最終值是串接後再轉（`C:/x/tmp/y`），逐 token 轉 `+=` 會發散。追蹤每個名稱的賦值歷史＝為 ~0 頻率加狀態，記臺帳（漏修，安全方向） | 值直接寫 `A=C:/x`，或把 `+=` 拆到不同次呼叫 |
| `find` 的 `pattern` 內嵌 temp 前綴（pi 專屬）：`pattern:"/tmp/*.txt"`、`pattern:"$TEMP/*.txt"` 且無 `path` | host 把 pattern 原樣交給 fd（含 `/` 就走 `--full-path`），絕對 pattern 對 Windows 全路徑永遠不匹配 → **靜默 0 筆**（實測檔案真的存在）。拆成 `path`＋其餘 pattern 會讓 fd 從 full-path 切成 basename 遞迴（實測 1 筆→3 筆，多出子目錄）＝**改語意**，所以不修；oc 的 `glob` 是另一個引擎（pattern 本來就相對 path），它的拆前綴修法不搬過來 | 把目錄寫在 `path`、pattern 只寫檔名：`path:"/tmp"`, `pattern:"*.txt"`（`$TEMP` 等變數形式也一樣） |

**C. 治療點在插件權限外（host 層；插件只能記臺帳）**

| 形 | 治療點 | 暫時寫法 |
| --- | --- | --- |
| cmd 輸出的 GBK 亂碼 | host 的解碼層（插件看不到原始位元組） | 同任務改用 bash 原生工具（`ls`/`grep`/`find`） |
| 指令字串裡成對的 `\\` 被 `-c` 折一層（實測 git-bash 專有；WSL bash 5.3.0 全部保留） | host 的 transport（stdin／temp script）；插件拿到的已是折過的字串 | 要位元組保真就把內容用 write 工具落檔，或寫 `\134` |
| oc host 自帶的 shell 預檢層：「Portable shell scanner」對 `cat <<*X` 回 error `Portable shell scanner cannot analyze command: heredoc`（2026-11-03 實測，外掛 ON/OFF 都一樣＝插件拿不到該事件；同段 `<<3`／`<<.E`／`<<$S` 則放行——host scanner 的判準不與插件掃描器同形，未逐一建模）。WSL bash 原生對照（腳本檔）：`cat <<*X`／`cat <<.E` 本體照印、後續指令照跑＝host 擋掉的是**合法** heredoc，回傳≠原生 | host 的 shell tool 預檢（plugin 權限外）；插件掃描器只收到 host 放行的形 | 定界符用字母開頭；必要的資料本體先落檔再 `bash 檔` |

- **cmd 的非 ASCII 亂碼**——cmd 照 console code page（本機 936＝GBK）編碼輸出、
  host 以 UTF-8 解碼 → 工具回傳≠真實終端機所見 → 依分界屬漏修；無忠實改寫：
  注入 `chcp 65001` 實測非確定性（同命令有時 UTF-8 有時仍 GBK）且會把內建訊息
  切英文；治本在 host 的解碼層（權限外）——如實記錄並回報，不在自己的層打補丁
  ；亂碼本身是可見訊號，模型可自矯正（改用 bash 原生工具）。
- **envp 前綴賦值的插件改寫不存在**（redesign，理由與替代見 redesign 小節）：
  值寫法由一行系統提示導正（gate ON 時注入 `VAR=C:/x`、native exe 單斜線旗標）；
  殘餘形仍屬漏修臺（下條）。
- **envp 殘餘形**（插件不改寫）——根相對路徑值、引號開頭值、清單值
  、含 `\` 的值、`export X=/c/…`（內建、argv 位置）、env 的選項交錯形（
  `env -u V X=/c/… node`——`-u` 之後的詞在參數位置；不帶選項的 `env X=/c/… node`
  同在邊界上：env 是 POSIX 外部程式、X= 參數跨 msys→native 邊界，實測原生
  轉換 `C:/x`，gate ON 下值原地抵達＝靜默錯位，教由系統提示處理）、重導向交錯形
  （`A=/c/x > log node`）、緊貼形靜態前綴止於盤符（`VAR=/c$(…)`）、
  **動態值頭**（`A=$(echo /c/x) node`、
  ``A=`echo /c/x` node``——實測：原生（轉換開）`node` 收到 `C:/x`、本機（轉換
  關）值原樣抵達 `/c/x` 且被 node 當磁碟相對路徑解析成 `C:\c\x`、exit 0 靜默
  ；`$(…)`／`` `…` `` 的結果值語法無法靜態判斷，與引號開頭值同屬開放集合）、
  函式與其他 msys 程式讀回值的混合邊界
  ——原生 envp 轉換按**整值語義**走（或保留值），靜態掃描看不到整值或
  參數語義。
- **引號載體內的 cmd（`bash -c 'cmd //c ver'`，單／雙引號同病，`env -i bash -c "…"` 同形
  ）**——同一故障深一層：`cmd //c` 原樣落在引號 payload 內。實測：轉換開 →
  原生層把 `//c` 轉成 `/c`、`ver` 正常執行（僅版本行）；轉換關 → cmd 收到字面
  `//c` 進互動模式（版本＋版權＋提示詞、exit 0）＝靜默。靜態修法需列舉「哪些程式
  把第一個參數當腳本執行」（bash/sh -c、node -e/-p、perl -e、python -c…）＝開放
  集合的猜測，且改寫引號內容就是改資料；與「外部 wrapper 條」相關而不同——那條
  開放集合在 argv 結構，這條在引號／參數語意。
- **`time -p cmd //c ver`（`-p` 結束指令位置）**——實測：轉換關 → cmd 收到字面
  `//c` 進互動模式（版本＋版權＋提示詞、exit 0）＝靜默；轉換開 → 原生轉換、
  `ver` 正常。靜態修法需列舉各保留字／指令的旗標何時結束指令位置（如 `time`
  的 `-p`）＝開放集合的猜測。
- **反斜線換行續接（`cmd \`⟨newline⟩`//c ver`；pi / oc 同形）**
  實測：轉換開 → bash 詞法先移除續接對、`//c` 經原生轉換成 `/c`、ver 正常；
  轉換關 → cmd 收到字面 `//c` 進互動模式（banner、exit 0）＝靜默。詞法層可解
  （閉集合的 bash 詞法規則），但跳脫對消费的上下文（引號內、heredoc 標頭行）
  各有不同語意，依「寧可漏修」記臺、不補貼。
- **指令字串裡成對的 `\\` 到 bash 時只剩一個**（工具回傳≠原生；病灶已量到：
  **git-bash 對 `-c` 操作數的引號處理**，不是宿主、模型或本插件）——實測本機
  git 2.56.0 的 `usr/bin/bash.exe`：傳輸通道決定一切。

  | 傳輸 | `\\\\`（2 個） | 4 個 |
  |---|---|---|
  | `bash -c "<cmd>"`（pi／pi-web 直接 spawn bash） | **1** | **2** |
  | oc `ctx.shell.hook` → host spawn（live 2026-11-04） | **1** | **2** |
  | `bash -s`（stdin） | 2 | 4 |
  | `bash <script-file>` | 2 | 4 |
  | `bash -c 'printf %s "$1"' _ X`（**資料**參數，非 `-c` 操作數） | 2 | 4 |
  | 非 MSYS 子行程（`node -e X`） | 2 | 4 |
  | `shell:true`（經 cmd.exe） | 2 | 4 |

  **原生 Linux 對照（WSL，bash 5.3.0）**：同一份 payload 用四個傳輸跑，
  **全部原樣保留**（1/2/3/4 個都對；`-c`、`-s`、script 檔、資料參數皆然）
  ⇒ bash 本身不折，這是 **Windows 上 git-bash 獨有**的 `-c` 操作數處理，也再
  一次排除模型與宿主。反過來說：把 transport 改成 stdin／檔案，等於讓
  Windows 的行為對齊原生 Linux 的語意。

  只有「成對」被折一層；單反斜線、`\134`（八進位）、`\"`、行尾 `\` 都不受影響
  （`echo` 這種完全不處理跳脫的指令也一樣折，所以不是解析端吃掉的）。
  `-lc`、`sh -c`、單／雙引號、`MSYS_NO_PATHCONV`、`MSYS2_ARG_CONV_EXCL`、
  `CYGWIN=noglob` 全都無效；`MSYS=noglob` 能保住反斜線，但它同時關掉 `-c`
  操作數的 unquote，含 `"` 或 `;` 的指令直接壞（實測 `tr "\n" " "`、
  `for …; do … done` 皆誤），**不可用**。而且 `.bashrc` 太晚：argv 在 bash
  讀 bashrc 之前就解析完（實測在 shell 內 `export MSYS=noglob` 無效）。
  定位過程：session transcript（`~/.pi/agent/sessions/*.jsonl`）顯示同一 session
  裡 `write` 的 `content` 與 `bash` 的 `command` 在 raw JSON 中轉義深度相同
  （解碼後各 2 與 4 個），落地卻是 content 2→2、command 2→1 ⇒ 模型與 JSON
  解碼都無罪；pi 的 bash 工具把 command 原樣交 spawn（`dist/core/tools/bash.js`
  實讀：只有可選 `commandPrefix` 前置）⇒ 宿主邏輯也無罪。
  **修法在 host 的 transport**（pi 已有 `commandTransport: "stdin"` 這個機制、
  目前只用於 legacy WSL bash）：改用 stdin 或 temp script 即位元組保真，
  不改任何指令語意。插件端**看不到原始位元組**（hook 拿到的是折疊前的字串，spawn
  時 transport 再折一層），「把反斜線加倍」會同時破壞合法的 `\n`、`\ `、`\|`＝誤修
  風險遠大於漏修 ⇒ 留臺帳、不補貼。**oc 與 pi 的折疊相同**（live 2026-11-04：2→1、
  4→2），**折疊本身的位元組損失仍然不可修**（插件看不到原始位元組）。
  實務：要保位元組的 payload（heredoc 內的
  `\\`、正則、Windows 路徑字面）用 write 工具落檔或 `\134` 寫法。


## oc 版：安裝形態與體積（v2.2.5 實測）

`opencode plugin add` = 用 pacote 把 spec 解析成 **codeload tarball**（
`https://codeload.github.com/<user>/<repo>/tar.gz/<commit>`，只取一個 commit，不 clone
歷史），解開後在安裝目錄跑一次 npm install（`@opencode/Npm`，arborist，
`--prefix <安裝目錄>`）。所以**是否有依賴，全看插件的 package.json**：

| 插件 package.json | 安裝結果 |
| ----------------- | -------- |
| 宣告依賴（含 `peerDependencies`） | 整個依賴樹都會下來；以 `@opencode/plugin` 當 peer 實測 273 套件 / 168 MB（npm 自動安裝 peer，它自己依賴 `@opencode/{ai,client,protocol,schema,util}` + `effect`） |
| 不宣告依賴（本 repo 的規則） | 1 套件；安裝目錄 12 KB（chat-trim-context）／48 KB（env-guard） |

`Plugin.define` 是 identity（實裝 tarball 的 `dist/effect/plugin.js`：
`export function define(plugin) { return plugin }`），所以插件自己宣告一份即可，不需要
host 的執行期模組；本地 plugins 目錄安裝也不必先裝任何套件。載入器只要求 default
export 是帶 `id` / `setup` 的物件。`oc-plugins/tests/packaging/` 把這個形狀釘死（無依賴
欄位、無 runtime import `@opencode/plugin`、default export 有 `id`/`setup`）。

每次 add/update 會新增 `~/.cache/opencode/npm/<key>/<timestamp>/`，舊目錄不自動清除；
`check` / `list` 由執行中的 server 回答（記憶體中的 registry），與磁碟狀態無關，server
沒重啟就不會反映刪檔。

**live 歸因前先對照快照新舊（2026-11-03 實測）**：安裝快照目錄可能整批落後 `master`
（`git-harness-plugins-*` 三個 timestamp 目錄都停在舊版，while 源碼樹已含當日 16:39Z
的修復 commit）——live 上看到的舊行為可能是「跑的是舊版模組」，不是「新版修復無效」。
判斷 live 所見前，先比對 cache 快照的 timestamp 與 `git log` 的 commit 時刻；正在跑的
session 的 plugin hook 也可快取舊 module，新碼上到 live 有時間差，不能只看本 session
的反應就下結論。

## oc 版：redesign 2026-11-05——為什麼不再掃描指令

輸入側 bash lexer 是開放集合：wrapper、引號、重導向、heredoc、case、函式本體
持續產生新形，而每個新形的可動作修法只有「再動 lexer」——oc repo 四天 25 個
commit、六個 misfix 都由同一個結構成本支付，「夠了」從來是判斷、不是機制。
redesign 把問題拆成兩件事：

1. **誤修母體移除**：輸入側不再改寫指令字串。「誤傷正確語法」這個失效類別在
   結構上不存在——沒有改寫器，就沒有誤修器。pi 提議的窄 fast-path（僅行首
   `cmd //c` 一種輸入側改寫）**刻意不採**：它省的是一輪自癒，買回的是整個
   誤修類別。
2. **開放集合改由輸出指紋接住**：cmd 互動 banner 是閉集合指紋（成功結果的前兩
   個非空行），wrapper／引號 payload／續行／`time -p`／heredoc 邊角等所有語法
   邊界形**同一時間結案**——偵測對象從「語法位置會不會踩雷」變成「事實上踩了
   沒」。誤判的失效模式是多一段 advisory 文字、零執行破壞；review 的主要利器
   （「你把對的改壞了」）在這個位置不存在。envp 前綴值改由 gate ON 時的一行
   系統提示導正——文字建議沒有改寫失效模式。

留下的輸入側修復只剩「欄位語意被宿主 API 密封」的閉集合 temp surface
（`path`／`glob` 前綴／`patch` 指令行／shell `workdir`）：`path` 永遠是路徑、
不是別的東西，改寫在結構上碰不到語法。完整決策（宿主能力查證、與 pi 的對照、
落地面、殘留 live 驗證）見 `docs/oc-env-guard-redesign.md`。redesign 前的 oc
掃描器（`scanBash`／`matchParen` 等，約 600 行）與其稽核史（零效應改寫稽核、
heredoc 規則、兩輪 live 對照）已隨之從本文件移除，證據在 git 歷史；其中
「統計與改寫同源」的結構原則仍然成立（見〈使用統計〉）。

## oc 版：接線與閘門

插件現在掛四個 hook，指令字串（`event.command`）一律不碰：

- 路徑類（輸入側、閉集合）：`ctx.tool.hook("execute.before")` 改 `event.input`
  （`path`／`patchText` 的指令行／`glob` 的 `pattern` 前綴）——input 可就地改動、
  改動直達執行（v2.2.5 實測兩處改寫都落到 spawn 的指令行）。
- **指令類（只讀）**：`ctx.shell.hook("create.before")` 做三件事：①身分
  驗證——`event.shell` 過 typeof 守門後以 `uname -s` 驗 MSYS 身分（按執行檔
  快取；v2.2.5 實測**無**非字串事件，typeof 是契約一致化：該 hook 拋 TypeError
  會弄壞 spawn 本身，契約外的分支一律選「外掛不存在時的原狀」）；②`event.cwd`
  （未解析的 workdir 原值）的 temp 改寫；③該次 spawn 的轉換狀態探測＋快取，
  供 banner advisory 措辭用。`event.command` **不改寫**——電池有一條單一斷言
  釘著「hook 對 command 永不變」。
- **輸出類（banner backstop）**：`ctx.tool.hook("execute.after")`——只對工具
  `"shell"`、`status==="completed"`、`metadata.exit===0`、非 timeout／signal
  的結果檢查 cmd 互動 banner 指紋（首兩個非空行 `Microsoft Windows [`＋
  `(c) Microsoft`；提示符行不入指紋、`cmd /c ver` 單行不命中），命中就在
  `result.content` 附加 `[env-guard]` advisory（宿主在 hook 後讀 mutate 過的
  event 再返回——改動直達模型，`packages/core/src/tool.ts:158–173`；truncate
  在 hook 之後跑，首部存活）。措辭用該次 spawn 從 `create.before` 探測到的
  轉換狀態（gate ON → `cmd /c`、轉換開 → `cmd //c`）；spawn 未經
  create.before 的狀態值沿用「轉換開啟」語義（提 `//c`，與 pi 的 probe 失敗
  預設同）。輸出截斷或指紋不完整 → 放行。
- **系統提示類（envp／native 旗標導正）**：`ctx.session.hook("context"／
  "compaction"／"generate")` 在實測 `MSYS_NO_PATHCONV` 存在時 push 一行純
  ASCII 提示（前綴賦值寫 `VAR=C:/x`、native exe 用單斜線旗標）。host 每次重建
  `event.system`，逐請求重 push 是 prompt-cache 友善；marker 防同一 event 內
  重疊。探測＝驗證過的 MSYS bash（`findBash()`，v2.2.5 實測 spawn 落點相同），
  一次計算、失敗即永不注入（inert，不猜）。
- temp 錨點問 bash 本身（`cygpath -w /tmp`）：`os.tmpdir()` 不是權威——本機對
  native 子行程 MSYS 已把 TEMP 轉成 Windows 路徑（實測），但定義 `/tmp` 的是
  shell 工具的 bash；`os.tmpdir()` 只在是真盤符路徑時當 fallback，無錨點 →
  改寫整體 inert（不猜 AppData 佈局）。
- `MSYS_NO_PATHCONV` 探測（presence-based：`0`／空字串也算停用，實測——探測
  驗「有設」（`${VAR+x}`）而非 `=1`；按 shell 快取）決定兩件事：banner
  advisory 的措辭與系統提示的注入。
- **閘門機制的精確版**（2026-11-03 停用外掛後重測）：`MSYS_NO_PATHCONV` 決定的
  不是「argv 一層、envp 另一層」的差異——它是**按次 spawn 查環境**：只要被
  spawn 的子行程環境裡帶著它（任意值，空字串也算），msys 對那次 spawn 的
  argv **與** envp 轉換就整層關閉；變數在哪一層被設上（父行程匯出、bashrc 的
  runtime export）不影響判定，bash 的啟動時刻也不特別（bashrc export 後
  再 spawn，子環境帶 NPC，一樣關）。也因此在 gate ON 的閘門語意成立：
  探測看到的 NPC 就是「該次 spawn 環境帶 NPC」，與轉換層實際關閉同義。
- **測量紀律**：量原生行為時，命令要走外掛碰不到的層——子層 spawn（`bash -c`
  的 payload、或從裸 node spawnSync bash）、或停用外掛（`opencode.json` 移除
  plugin 條目，hot-reload 立即生效）並用顯著例子對照後再量（`A=/q/x node`：
  有汙染時印 `Q:/x`、乾淨時印 `/q/x`）。這條紀律的教訓來自頂層命令字串曾被
  改寫中毒的事故（賦值被外掛自己改掉、被誤判為原生轉換，導致「envp 改寫是
  no-op」的錯誤結論）；redesign 移除輸入側改寫後結構性成因消失，但紀律保留
  ——未來若加回任何輸入側改寫，本條重新生效。

已知無害邊界（如實記錄、不修）：

- glob 前綴拆分把 rest 的反斜線一律轉正斜線——rest 含 `\*`／`\[` 這類 glob
  轉義時語意會變（有機頻率為零；若要防僅對含這類序列的 rest 保留反斜線，
  依臺帳紀律選擇記錄不修）。
- glob 整體 bare temp 模式（`pattern:"/tmp"`／`"${TEMP}"` 且無 `path` 欄）：
  `splitTempPrefix` 要求 rest 非空（`^[\\/].+`）→ 原樣放行，host 端照字面
  匹配＝靜默 0 結果。保守閘是刻意的（把 pattern 搬進 `path` 會重整呼叫形）
  ；有機頻率極低，記為邊界（2026-11-03 稽核）。
- `PATCH_PATH_LINE` 的 `[^\r\n]+?` 會抓到路徑行的行尾空白（實測：`*** Add File:
  /tmp/ws.txt ` 的路徑值帶尾隨空白）——host 解析會 trim、兩端收斂（審查時對照
  過），無需修。
- 插件唯一就地改動的工具事件是 `event.input`／`event.cwd` 的欄位值與
  `result.content` 的附加 text part，每個分支都 typeof 守門、附加動作
  try-wrapped（`event.tool` 缺欄曾直接 TypeError 的問題已補守門，電池有釘）。
- 工具覆蓋面（v2.2.5，官方 v2 文件＋本機二進位交叉核對）：host 端解析路徑的
  內建工具＝read/write/edit/glob/grep（path）＋patch（patchText）＋shell
  （workdir），無 `list`/`ls` 工具。官方文件另列實驗性 `experimental_image_generate`
  （參數含 `path`；本機二進位確認存在），其 path 解析層位置未驗證——探測不到
  就不修，待下次 e2e 或版本升級補一條 `path: ${TEMP}/x` 實測，確認 host 會建
  字面 `${TEMP}` 目錄才把該 key 加進 `PATH_TOOLS`；`session_move.directory` 屬
  工作區移動、temp 形態不太會有機出現，僅記錄。

## oc 版：邊界判準（「什麼算合理的 edge case」）

判準不是「所有想像得到的語法」，而是「這個 host 的轉換層是否弄壞它」×「agent 實際
會不會寫」×「修了會不會改變語意」×「修復位置是否閉集合」：

1. **轉換層弄壞、且修復位置被宿主 API 密封 → 修（輸入側）**：host 自己解析路徑
   （檔案工具 `path`、`patch` 指令行、`glob` 前綴、shell `workdir`）——`path`
   永遠是路徑、不會是別的東西，這些改寫在結構上不可能誤傷語法。這是 redesign
   後唯一的輸入側修復對象。
2. **轉換層弄壞、但修復位置在 bash 語法裡 → 不改輸入，判定移到輸出／指示層**：
   cmd 互動 banner 是閉集合輸出指紋 → `execute.after` backstop；envp 賦值 /
   native exe 旗標的正確寫法 → 一行系統提示（gate ON 時注入）。指令字串裡的
   關鍵字、分隔符、引號、`$( )`、`time/exec/command/env/builtin` 等語法位置
   **一律不再掃描**——同樣的故障、但靜態修法是開放集合（見 redesign 小節）。
3. **外部程式的 argv 佈局 → 不修**：`timeout 10 cmd //c`、`nice`、`xargs cmd //c`、
   `sudo cmd //c`。要修就得逐一建模「哪個參數才是被執行的指令」——那正是
   AGENTS.md 禁止的「列舉所有可能工具」。這類形若真的進了互動 cmd，banner
   backstop 會接住（cmd 本身）；cmd 以外仍留臺帳。
4. **要執行才知道的 → 不修**：`$C //c`、alias、`eval`、`${TEMP:-/tmp}/x`——靜態
   邊界外。cmd 形若進互動模式同樣由 backstop 接住；其餘 loud 原生失敗。
5. **有機頻率為零的語法 → 已由既有機制自然涵蓋的才加分支**：redesign 後語法
   位置零分支，這條判準只約束未來提案。

**提案的終止條件（redesign 記錄 §1）**：任何新修復必須逐項過 AGENTS 審查清單
（指名故障點＋兩態實測＋閉集合＋誤判代價有界），舉證責任在提案方——以判準裁定
而不是靠 flag、行數或「我覺得夠了」。

**語料實測（本機 opencode.log 的 508 條真實 `bash -c` 指令）**：20 條含 `cmd` +
`//`，其中只有 **2 條是真的要執行 cmd**——1 條在指令起始、1 條躲在外部包裝器
`timeout 10` 後面；其餘 18 條都是資料（`echo cmd //c ver` 對照、heredoc／commit
message／JSON 內文）。**有機出現次數**：引號指令名 0、變數指令名 0、全路徑
`cmd.exe` 0——redesign 後這些形都不再有語法分支：真進互動 cmd 的由 backstop 接住
，其餘是 loud 原生失敗。

**測量歸屬**：檔案工具 `/c/...` 的原生解析測於 v2.2.1，v2.2.5 只重測了 shell
`workdir`；其餘每一列都在 v2.2.5 上重跑過。

**驗證深度**：單元電池（見下方〈測試〉；純函式、含刻意不修與上述邊界）；live 驗證
是「每個表面一輪乾淨對話」，用外掛之前註冊的 probe 記錄模型原值，再對照磁碟／
輸出——不是窮舉，但每個修復至少有一條端到端證據；語料掃描用來決定「哪些形式值得
處理」。

## 使用統計（實作）

量測外掛實際命中率：清單內工具的呼叫次數（分母）與各修復的觸發次數（分子）。
分類學 pi／oc 沿用（cmdc 未實作；OpenCode 的各 surface 用同一組機制鍵）：

| key                                                            | 觸發點                                             | variant 合併範圍 |
| -------------------------------------------------------------- | -------------------------------------------------- | ---------------- |
| `path.tempMount` / `path.tempVar` / `path.other`               | 檔案工具 `path`（pi／oc）                          | `/tmp` 與 `/TMP`／`/tmp\foo` 同一種；`$TEMP/$TMP/$TMPDIR`、`${…}`、`%TEMP%` 同一種；`.other`＝未來未分類改寫的可見 fallback |
| `glob.tempMount` / `glob.tempVar`                              | oc：glob pattern 前綴拆分                          | 同上兩族；前綴只能落在其中一族（沒有 `.other`，glob split 只回 temp 命中） |
| `patch.tempMount` / `patch.tempVar` / `patch.other`            | oc：patch 指令行改寫                               | 同上；一次 patch 可同時 +1 兩個機制 |
| `shell.workdir.tempMount` / `shell.workdir.tempVar` / `shell.workdir.other` | oc：shell `workdir` 改寫              | 同上 |
| `shell.cmdBanner`                                              | 輸出側 cmd 互動 banner 偵測（pi 2026-11-04、oc 2026-11-05） | 單一故障點（成功輸出＋雙行 banner 指紋）：無 variant 合併問題 |

`shell.cmdFlag`／`shell.envPath` 曾屬輸入側掃描器（redesign 移除；理由見 oc
redesign 小節），舊統計檔歷史計數由 `adoptCounts` 保留；cmd 形與 envp 值的現行
處置（`shell.cmdBanner`、系統提示）分別見〈oc 版：接線與閘門〉。**統計與改寫同
源**：每個 key 與一段實際的改寫／偵測程式碼一一對應（觸發點＝該段程式碼）——
統計能拆到「機制」粒度，是因為改寫端就照機制拆；拆不掉的地方不造新鍵。

**切鍵判準**：key ＝**surface × 故障機制**，不是「值長什麼樣」。同一機制下的
拼法差異（`//c` 與 `//k`、碟符值與 `/tmp` 值、大小寫與分隔符）合併；機制不同的
即使結果一樣也要分開——`/tmp` 是 host 不套 MSYS 掛載映射、`$TEMP` 是 host 不
展開變數，修好一邊不代表另一邊修好。同一個機制在不同 surface 也分開（檔案工具
`path`、`glob` 前綴、`patch` 指令行、`workdir` 是四段獨立的改寫程式碼，修好
`path` 不代表 `glob` 會跟著好）。`path.other`／`patch.other`／
`shell.workdir.other` 是可見 fallback（glob split 只回 temp 命中，沒有
`.other`）：未來新增未分類的改寫會落在對應的 `.other`，不會靜默混進別人的
鍵。舊檔裡的 `path.temp`／
`glob.tempPrefix`／`patch.tempLine`／`shell.workdir.temp` 不重新命名（歷史資料
照舊，新計數走新鍵）。

**計數單位是「呼叫」不是「出現次數」**：分子以「一次工具呼叫／一次命中」為單位
——同一個 patch 內多個指令行只 +1 次掃描（每命中機制各 +1）。分母不受影響（本
來就是呼叫次數）。`shell.cmdBanner` 在 banner 命中時對該則結果 +1。

- **分母** `toolCalls[tool]`：清單內工具每次呼叫 +1。gate 的邊界（2026-11-04
  重測、redesign 復核後）：非 win32 或 PATH 等找不著驗證過的 MSYS bash →
  setup 直接 return、完全不計數；找到 → hook 安裝，檔案工具的分母與 temp 改寫
  照計。shell hook 只有在 `event.shell` 驗證為 MSYS bash 時計 `bash` 分母＋
  做 workdir 改寫。
- **分子** `fixes[key]`：真的改寫才 +1，以故障點為 key；同性質 variant 合併、
  不同類型分開。
- **2026-11-04 live 欄位驗證（oc v2.2.5，讀 `kv` 的
  `plugin:…:stats`）**：依序觸發四種修復，delta 各自落在正確的鍵且互不污染
  （`cmd //c echo` → `shell.cmdFlag`；`A=/c/x node` → `shell.envPath`；
  檔案工具 `read` 的 `/tmp/...` → `path.tempMount`；`glob` 的
  `pattern:"${TEMP}/*.txt"` → `glob.tempVar`——同一次 read/glob 的分母也各
  +1；非 MSYS shell、非清單工具不計）。這驗證了「同一機制合併、不同機制分開」
  在真實 host 的寫入路徑上成立，不只是 fake-ctx 電池。實測當時 cmdFlag／
  envPath 尚在；redesign 後的新鍵 `shell.cmdBanner` 待 live 重驗
  （`docs/oc-env-guard-redesign.md` §6）。

### 儲存（各走官方機制）

- **OpenCode**：官方 `ctx.storage`（plugin-scoped durable JSON，`get/set/remove/
  scan`），實體落在 `~/.local/share/opencode/opencode.db` 的 `kv` 表——host 自己
  管遷移，插件不碰實體路徑。整包存一個 key（`"stats"`）。**刻意不用自己寫 JSON 檔**：
  插件 Context 沒有可 import 的目錄 API（不像 pi 的 `getAgentDir()`），自己解路徑
  就是猜佈局，猜錯的失敗模式是統計檔靜默分裂；`~/.local/share/opencode` 也有被
  host 重建的前科（GitHub issue #34445）。
- **pi**：pi 不提供 per-extension 儲存 API（`docs/extensions.md` 的 State 段：
  session 外的資料＝external storage，由擴充自選），放官方 agent 目錄——
  `getAgentDir()/env-guard-stats.json`（官方匯出的路徑，吃 `PI_CODING_AGENT_DIR`
  覆蓋），不自己復刻路徑邏輯。**實測歸屬**：`getAgentDir` 是 runtime export 且回傳
  `C:\Users\artin\.pi\agent`、`session_shutdown` 見於官方 `docs/extensions.md`
  ——兩者都對照安裝中的 `@earendil-works/pi-coding-agent` 1.4.0（`require` 實跑＋
  dist 內 grep）驗證過；測試電池 stub 掉了這兩個 API，故在此另記實測。

### 寫入時機與安全

- 分子（修復觸發）**即時落盤**——觸發低頻，一次小寫入可接受，unload/reload 不掉資料。
- 分母（工具呼叫）**in-memory 累加 + 5 秒 debounce**（每次呼叫不該付一次 IPC／磁碟
  寫入；timer `unref` 不擋退出），pi 在 `session_shutdown`、oc 在 setup cleanup
  （插件卸載）補冲。oc 的 cleanup 回傳 promise（官方 `@opencode/plugin` dist 的
  `Cleanup = () => Promise<void> | void`），host 可以等到最後一筆寫入完成。
- **讀檔-合併-寫入**：jiti reload／新 session 的 module 重新載入、或 opencode 重啟
  後，沿用先前累積的計數，不清零、不覆蓋。
- pi 寫檔用 tmp+rename，避免讀到半截 JSON；tmp 檔名帶 PID（多個 session 並存時
  不會 rename 走彼此寫到一半的檔）；落盤前**重讀合併**——並發 sessions 各自
  from-load 累加、後寫覆蓋先寫（last-writer-wins）會吃掉對方增量，合併把
  「本 session 的增量（現値−載入基準）」疊到檔上最新値，合併結果同時成為
  新的記憶體値與基準（重複 flush 不雙計；計數僅 advisory）。
  **2026-11-04 修**：基準原本只在「合併」分支更新——**首寫**（檔案不存在／讀不了
  →直寫現値）之後基準還是全零，下一次 flush 會把同一批增量再疊一次（實測：全新
  統計檔＋一個 `shell.cmdFlag`＋`session_shutdown` → 記成 **2**）。現在寫檔後
  無條件把基準 re-base 到剛落盤的值（幂等），電池用全新 process＋空 agent dir
  釘樁。實務影響限於「剛刪檔／首次執行」那一批；舊資料不重算。
- **任何統計失敗都吞掉**：先做完原有改寫再計數；storage 壞掉時 hook 照常註冊、
  改寫照常運作、cleanup 不拋錯；壞檔／畸形資料 shape-check + 數值轉換，絕不致命。
- oc（**2026-11-03 版**，與 pi 同機制的移植）：`ctx.storage` 無 compare-and-set，
  兩個 opencode share 同一 db kv——只有「讀檔-合併-寫入」的第一條時，各自 from-load
  累加的整包快照會互相覆蓋（last-writer-wins 窗口＝整個進程壽命）。修法：flush 時
  **先重讀 store 最新値**，把自己「當下本機計數−上次 baseline」的**增量**疊上去；
  baseline 隨即 re-base 到本次快照（save 等待期間落進來的 bump 歸下一次 delta，
  不再二次投遞——鏈式 flush 曾因 aliasing 雙計，電池有併發與連續 read-modify-write
  釘樁）；命令數同值時重複 flush 冪等。寫入仍串行鏈在前一筆之後（racing 的 `set`
  不會把舊快照最後落盤）。記憶體 `stats` 只持本機値（載入値＋本進程 bump），只有
  寫入値是全域合併結果。**殘餘**：單次 flush 的 get..set 之間（無 CAS、持鎖無望，
  計數僅 advisory）另一 server 的寫入仍可能被覆蓋——窗口從進程壽命收窄到單次
  get..set，不再補貼；錯誤照樣吞掉，修復路徑不 await。

## oc 版：實測記錄（v2.2.5，一次乾淨對話；2026-11-03／04 量，外掛 0.1.6）

> 量測當時外掛仍是掃描器版：`cmd //c` 諸列記錄的是**當時**輸入側改寫
> 後的 spawn 行為，redesign 後 `cmd //c` 原樣抵達 bash、進互動模式時由
> banner backstop 附加 advisory（live 重驗計畫：`docs/oc-env-guard-redesign.md`
> §6）。temp／workdir 諸列行為不變（改寫位置與錨點未動）。

模型的原始輸入（外掛在 `execute.before` 之前記到的原值）與最終落點：

| 步驟  | 模型送出的原值                                                                 | 結果                                                                                                                              |
| ----- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| write | `path: $TEMP/oc-g2.txt`                                                        | 落在真實 `C:\Users\artin\AppData\Local\Temp`，專案下無字面 `$TEMP`                                                                |
| write | `path: ${TEMP}/oc-g4.txt`                                                      | 同上（大括號形式）                                                                                                                |
| write | `path: $TMPDIR/oc-g8.txt`                                                      | 同上                                                                                                                              |
| write | `path: ~/oc-g6.txt`                                                            | `C:/Users/artin/oc-g6.txt`（host 原生展開 `~`，不動）                                                                             |
| read  | `path: /tmp`                                                                   | 列出真實 temp 的 1951 個項目                                                                                                      |
| glob  | `pattern: ${TEMP}/*.txt`（無 path）                                            | 修正前 0 筆；修正後 100+ 筆（含真 temp 的 txt）                                                                                   |
| patch | `*** Add File: ${TEMP}/oc-g9.txt`                                              | 修正前建字面 `${TEMP}` 資料夾；修正後落在真實 temp                                                                                |
| patch | `*** Update File: ${TEMP}/oc-m1.txt` + `*** Move to: ${TEMP}/oc-m2.txt` + hunk | 改名成功到真實 temp（內容 `alpha`/`gamma`/`beta`）；`Move to` 與 Add 是同一條 host 解析，未改寫會落到字面 `${TEMP}`（Add 已實測） |
| patch | `*** Delete File: ${TEMP}/oc-m2.txt`                                           | 刪掉真實 temp 的檔案；後續 `read` 回報該真實路徑 not found                                                                        |
| shell | `workdir: /tmp`、`command: pwd`                                                | 修正前 `Working directory does not exist: C:\tmp`；修正後 `pwd` = `/tmp`                                                          |
| shell | `cmd //c ver`                                                                  | spawn 行為 `-c "cmd /c ver"`，輸出 `ver` 的正常單行（GBK 編碼，解碼後為 `Microsoft Windows [版本 10.0.19045.7725]`）              |
| shell | `cmd //c "echo hello world"`                                                   | `hello world`（引號與 payload 原樣抵達 cmd）                                                                                      |
| shell | `cmd //c "echo one" && cmd //c "echo two"`                                     | `one` / `two`（兩段都改寫、`&&` 交由 bash）                                                                                       |
| shell | `v=$(cmd //c echo sub); echo "got:$v"`                                         | `got:sub`（`$( )` 內也改寫）                                                                                                      |
| shell | `cmd //c dir /b \| head -2`                                                    | 正常列出（管線後段是 bash 原生）                                                                                                  |
| shell | `echo cmd //c ver`                                                             | 原樣 `cmd //c ver`（資料位置不動）                                                                                                |

---

# system-prompt (cmdc)

機制：建立檔案就生效——host 的發現規則讀 `<專案>/.commandcode/` 與
`~/.commandcode/`（專案優先於全域），`SYSTEM.md` 整份取代、`APPEND_SYSTEM.md`
附加在後。每輪都重讀：位元組沒變時 prompt cache 不會破，所以「生效／失效」的
邊界就是檔案內容本身。

**實測（command-code 1.88.0，inputTokens）**：

| 情境                              | inputTokens |
| --------------------------------- | ----------- |
| 基準（無 mod、無檔案）            | ~16,265     |
| `APPEND_SYSTEM.md`（一行 marker） | 16,283      |
| `SYSTEM.md`（一行 marker 取代）   | 7,593       |

---

# disable-tools (cmdc)

機制：用的是 mod host 的 `setActiveTools` filter（`withModToolFilter`），不是
permission deny（deny 只擋執行、schema 照樣進 context）。被列名的工具**完全不進
model**：schema 不送出、執行被拒（loud failure，agent 可自癒改道）、sub-agent 也
拿不到。

- 不會頻繁切換，所以不做外部檔案：改常數後 `/mods reload`（或新 session）生效。
- session 開始時套用一次、每次 `run_start` 再套用一次——背景連線的 MCP 工具
  不會被舊快照誤殺，只有被列名的才會被濾掉。
- 空陣列 → 完全不作用（不呼叫 `setActiveTools`，不干擾其他 mod 的 filter 設定）。
- 已知缺口：`shouldDefer` 工具（web、sleep、task_*、worktree 等）本來就不進
  schema、走 `search_tools` 延遲載入，而 search pool 不過 mod filter——被禁用
  的 deferred 工具仍可被搜到並載入 schema，但**執行一樣被拒**（實測回
  `No tool named "web_search" exists`）。要連發現都擋掉，只能等 host 過濾
  search pool，目前無解。

> 沒有 JSON-only 的替代：settings/config 註冊表沒有 per-tool 開關；能「整組
> 不註冊」的只有寫死的功能閘（`artifactsEnabled: false`、`COMMANDCODE_DISABLE_CRON=1`、
> codemode `off`、todos mod 預設關）。通用禁用只有 mod `setActiveTools` 這一條路。

---

# chat-trim-context (oc)

`id: chat.trim-context` — 針對 `chat` agent，在每次送出模型請求前（`context` /
`compaction` / `generate`）清理系統提示：

- 移除 `<env>...</env>` 環境資訊段落
- 移除包含 worktree marker（`tools.opencode.session_move`）的段落

---

# 測試

測試放 **host 資料夾的 `tests/` 下**、與插件資料夾分離——插件資料夾保持只含交付物，
手動安裝（`cp -r` 插件資料夾）不會把測試帶進安裝目錄。單元電池直接 import 插件
TypeScript（Node type stripping，無建置步驟）；pi 版把 host 才解析得到的 runtime
import（`getAgentDir`）換成 stub、從系統暫存目錄的拋棄式副本載入（repo 內不留任何
產物），oc 版則不需 stub（插件沒有執行期依賴），同一套拋棄式副本機制照用。
`oc-plugins/tests/packaging/` 另外釘死安裝體積的形狀（無依賴欄位、無 runtime import
`@opencode/plugin`、default export 有 `id`/`setup`）。worker 場景（無錨點／探測開關）
各自跑獨立 process（module 級快取會釘死情境）。

涵蓋（env-guard）：每一條修復與刻意不修（釘死防回歸）、hook 接線（含 shell
hook 的 typeof 契約守門——無實測故障點、釘的是契約）、banner 指紋（病理形
一行／三行／含空行／無版本行、無害形 `cmd /c ver` 單行、背景結果）與
`execute.after` 契約（非 shell、非 completed、非 exit 0、idempotency）、系統
提示的 marker／重複防疊／探測失敗不注入、gate 的兩個方向（轉換開／關的機器
都能跑同一份電池）、統計的分母 gate、各 fix key、persisted 往返與
read-modify-write、畸形資料、壞 storage 韌性、並發 server 的 delta 合併／
幂等 flush／合併後仍會遞增（2026-11-03 H6 修的釘樁，兩份拋棄式 module 副本
共用一個 fake store 模擬兩進程）、pi 首寫不雙計（2026-11-04：全新 process＋
空 agent 目錄的 worker）。輸入側移除由「`event.command` 永不變」單一斷言釘住
——沒有改寫器就沒有「改歪」可逐形釘樁，一條斷言守的是整個誤修類別。

執行方式見 README 的〈開發〉。

**E2E 對照的判準（envp 家族，留檔：未來任何輸入側改寫提案應復用；現行電池無
envp 改寫）**：不只比字串，而是把指令送進
真 bash 跑兩次——原生（把 env 的 `MSYS_NO_PATHCONV`／`BASH_ENV`／`PWD` 刪掉，
讓 MSYS 自己做 envp 轉換）與改寫後（保留本機環境），比 exit 與 stdout。`PWD`
必須兩側一起隔離：harness 可能匯出 Windows 形，`$(pwd)` 會與改寫無關地發散
（實測 `VAR=/c/x$(pwd)` 的 native 變成 `C:\xC;\Users…`）。gate ON 方向用
`MSYS_NO_PATHCONV=1` 跑同一份電池。這才真正驗證「改寫規則 ≡ MSYS 的轉換規則」
（`/tmp` 錨點也因此被釘住：改寫後的值必須等於 MSYS 自己轉出的值）。cmd //c
家族不在此列（互動模式會掛，而且那是旗標不是 envp）。另外兩個刻意另開的模組
副本：沒有 `getShellConfig` 的舊宿主（驗證整體 inert、handler 不拋、不傳 ctx
也行）、worker 場景（無錨點／探測開關）。
