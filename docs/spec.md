# 技術規格（spec）

使用者須知（修了什麼、會看到什麼、怎麼設定、怎麼看統計）在根目錄
[`README.md`](../README.md)；這份記**技術架構、設計判準與實測證據**。通用判準
（原生執行優先、修復審查清單、驗證紀律）見 [`AGENTS.md`](../AGENTS.md)，此處不重複。

三個 host 各自實作：cmdc 與 oc 目前共用同源的輸入側掃描器（env-guard 的
`matchParen`／`scanBash` 等），pi 已於 2026-11-04 redesign 移除掃描器、改為
輸出側偵測（見〈pi 版：機制〉）。但**每一條修復的「適用性」是在本 host 重新量過才留**：同一顆 bash 在不同 host 的
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

本文件的 pi 掃描器稽核段（零效應改寫稽核、兩輪重跑）隨掃描器一併移除，證據在 git 歷史（e5b415f 及其前）；oc 對應段落保留原文，待 oc 代理 redesign 時處理（交接說明：`docs/oc-env-guard-redesign.md`）。

**活體 e2e 與工具面**：pi 檔案工具 host 端解析 `/c/...`，不重複改寫；host 自己解析的路徑欄位只有 read/write/edit/grep/find/ls 的 `path`。bash 與 powershell 沒有 `workdir`，pi 沒有 patch/glob 內建工具；find `pattern` 與 grep `glob` 不屬於 path 修復面。

### 刻意不修與漏修的分界

分類判準：**刻意不修＝原生失敗——工具的回傳與原生相同**（agent 看到的是真實原因
、可自癒）；**環境轉換層造成的失敗（工具回傳≠原生）不論大聲或靜默都是漏修**——
大聲只是失敗的形態、不是不修的豁免；漏修留在臺帳，僅因每個靜態修法都需要開放集合
的猜測（以誤修風險為界：寧可漏修、不可誤修）。

**刻意不修（原生行為或模型自身錯誤，讓它壞）：**

> pi redesign 註記（2026-11-04）：pi 的輸入側掃描器已整體刪除——本節、〈只能靠寫對的形〉與〈掃描器要點〉中所有涉及「pi 掃描器會／不會改寫」的描述均為歷史記錄（證據在 git 歷史），對 pi 不再生效；pi 對 cmd 形的現行處置＝輸出側 banner backstop：凡實際進入互動 banner 的形（wrapper／payload／續行／重導向前綴／time／算術等邊界形）一律不改寫輸入、命中即附加 advisory；輸出被截斷或指紋不完整則漏過；cmd 以外的 native exe 旗標與 envp 賦值不在覆蓋範圍。條目中的 bash 原生行為實測與 oc 描述仍然有效（oc 尚未 redesign，交接見 `docs/oc-env-guard-redesign.md`）。

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
  switch：四種組合（原生／本機 × 原形／改寫成 `/server/share`）實測**全是互動
  banner**，改寫零效應 → 掃描器跳過 UNC 形（`//alpha` 後面緊接 `/`），電池釘樁。
  **2026-11-03 修正**：此「跳過」先前只是文件聲明，掃描器旗標正則的終止字類
  `(?![\w.-])` 少了 `/`，實測會把 `cmd //server/share ver` 改寫成 `/server/share`
  （零效應改寫），且同根因的 `cmd //c/d/e ver` 改寫後行為翻轉（本地＝banner、
  改寫＝`系統找不到指定的路徑`；native 兩態皆 banner）。終止字類補 `/` 後兩形
  都保持原樣（`///c` 由 curTok 非空閘擋住，實測不改）；電池另補掃描器面釘樁
  （原本只有 path 工具面那條）。pi 版無此問題：pi 在 `cmdFlag.exec` 後有明確的
  `command[i + m[0].length] !== "/"` 閘＋電池釘樁——oc 是移植時掉了這層，這次
  以終止字類補 `/` 的正則一道蓋掉（兩 host 掃描器同源，判準相同）。
- 原生就壞的 cmd 雙斜線形（`cmd //?`、`cmd ///c`）——
  實測轉換開啟時一樣進互動模式：模型自己寫錯，不修。
- **緊貼形 `cmd//c`／`cmd//k`／`"cmd"//c`**——bash 把 `cmd//c` 當**程式名**
  （不是 `cmd` 加旗標）：原生是 `bash: cmd//c: No such file or directory`、
  exit 127，兩種轉換狀態下逐位元相同（實測）。所以沒有環境故障點——改寫它
  不是修環境層，而是插一個空格把一個詞拆成兩個＝替模型改錯字。附帶量測更正：
  這條 rewrite 只在「轉換關閉」時啟動，而轉換關閉下 `cmd /c ver` 實測就是
  直接跑 `ver`；banner 是**轉換開啟**時 `/c` 被轉成 `C:/` 的病理，兩者不會
  同時發生。此形原屬「已修」，實測後改列刻意不修（電池釘樁 `cmd//c ver`、
  `cmd//k`、`"cmd"//c ver`、`x=1 cmd//c ver`）。
- exec/command/builtin 後的賦值形（`command X=/c/x node`、`exec X=/c/x …`、
  `builtin X=/c/x …`）——這些詞後接的是參數：bash 把 `X=/c/x` 當指令名跑、
  原生就大聲失敗（實測 127／127／1、兩種轉換狀態同訊息）＝回傳≡原生，不修
  ；掃描器對應不暫存該賦值（此前會暫存並改寫死文字的錯誤訊息＝雜訊級誤觸
  ）。`env X=/c/x node` 例外且已修：env 是 POSIX 外部程式，X= 參數跨
  msys→native 邊界（實測原生轉換 `C:/x`）。
- **引號詞裡的偽賦值形（`A=/c/x "B=/c/y" node`）**——bash 的賦值前綴判定在
  quote removal 之前，引號詞是**指令字**不是前綴（實測 `B=/c/y: No such file
  or directory`、127）→ 不暫存、不套用。這條同時是掃描器的跨度陷阱：引號詞
  在 `out` 裡帶著前後引號，用 `curTok` 長度回推跨度會吃掉收尾引號（實測曾
  輸出 `A=C:/x "BB=C:/y node x`＝引號配對被破壞、語法被改壞）——修正方式
  是不走跨度算術（記 `tokQuoted` 旗標、該詞只當普通指令字結束指令位置）。
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
每列的「實測」都是在這台機器上兩種轉換狀態各跑一次得到的；oc 的 surfaces
（`path`／`glob`／`patch`／`workdir`）共用同一張表，差別只在被改寫的欄位。

**A. 刻意不修（回傳≡原生：原生就壞，或 host 已經處理）**

| 形 | 實測 | agent 該怎麼寫 |
| --- | --- | --- |
| `C:\tmp` | 原生寫入成功（合法 Windows 路徑） | 要「真實 temp」就寫 `/tmp` 或 `$TEMP`（這兩個插件會改寫） |
| `~/x` | host 自己展開 | 照寫即可 |
| `/c/Users/x`（檔案工具 `path`） | pi／oc host 原生映射成 `C:\Users\x` | 照寫即可（不要再期待插件改） |
| `>nul`／`2>nul`／`<nul`／`2>&nul` | bash 原生：建實體 `nul` 檔／ENOENT／ambiguous redirect | 要丟棄輸出寫 `/dev/null` |
| 重導向目標的 `//x`（`cmd //c x > //out`） | 目標由 bash 自己開檔，`//out: Is a directory` | 目標寫正常路徑 |
| `cmd //?`、`cmd ///c ver`、`cmd //server/share`、`cmd //c/d/e ver` | 模型錯字。`///c` 兩態**輸出不同**：轉換開啟＝互動 banner、本機＝意外跑到 `ver`；都不改（修它＝替模型改錯字）。`//server/share` 四態全 banner；`//c/d/e` 同族（2026-11-03 起掃描器確實跳過，見〈零效應改寫稽核〉） | 執行就寫 `cmd //c <cmd>`（使用 `cmd /c`；需轉換開啟的環境則為 `cmd //c`） |
| 緊貼形 `cmd//c`、`cmd//k`、`"cmd"//c`、`x=1 cmd//c` | 原生 127：bash 把 `cmd//c` 當**程式名** | 程式名與旗標之間要有空格 |
| `exec X=/c/x …`／`command X=/c/x …`／`builtin X=/c/x …` | 原生 127／127／1：bash 把 `X=/c/x` 當指令名跑 | 前綴賦值要直接接真指令字 |
| 引號偽賦值 `A=/c/x "B=/c/y" node` | 原生 127（`B=/c/y: No such file or directory`）：賦值判定在 quote removal 之前 | 同上；引號詞不是賦值前綴 |
| 未引號 Windows 路徑 `cmd.exe`（`C:\\Windows\\…\\cmd.exe`、`C:\Windows\…\cmd.exe`、`/c/Windows\…`） | **兩層轉換，host 相同**（2026-11-04 live 重測 oc）：transport 先把每對 `\\` 折一層（2→1、4→2），bash 未引號 lexer 再去一層跳脫。**1–2 個反斜線** → `C:Windows…`（127，不改）；**3 個以上**（3/4 已實測）→ 真實的 `C:\Windows\…`（程式存在、會跑 cmd）。oc 現在用 fold+lexer 兩層模型（3/4 命中）；pi 仍是「全去反斜線」（3/4 漏修，本輪不動 pi）。**引號**的 `"C:\Windows\…\cmd.exe"`／`"/c/Windows\…"` 在兩 host 都是字面分隔符、真的跑 cmd，照樣命中 | 用全正斜線的 POSIX 路徑，或直接寫 `cmd`；要寫 Windows 路徑就加引號（兩 host 一致），或把反斜線加倍（3 個以上，3/4 已實測） |
| `del x`、`dir /b`、`sc /query …`、`reg query //?`、`findstr //?` | 兩態同結果（`del` 不存在、`dir /b` 是 MSYS `dir` 的非法參數、`sc` 的子命令是 `sc query` 不是 `/query`） | 用 bash 原生工具：`rm`、`ls`、`sc query` |
| `( … ) cmd //c …`、`{ …; } cmd //c …`、`if … fi cmd //c …`、`while … done cmd //c …`、`case … esac cmd //c …`、`f() cmd //c …` | 原生語法錯誤（exit 2）：複合指令／函式本體結束後沒有分隔符就接簡單指令（函式本體必須是複合指令） | 加 `;`／`&&`／換行。**兩個 host 都已不開命令位置**（pi 2026-11-04 補上收尾詞集與函式本體槽，見〈零效應改寫稽核〉） |
| `for x in cmd //c …`、`case … in … pattern` 這類 slot | list／pattern 是資料，不是指令（實測 `for x in cmd //c` 印 `[cmd] [//c]`） | 要執行就寫在 body／指令位置；插件不會改寫 list 內容 |

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
| `function f { … cmd //c …; }`（`function` 名稱槽後的本體） | 掃描器追蹤 `f()` 形式、不追 `function NAME` 的名稱槽；實測這個寫法漏修（`f() { … }` 會改寫） | 用 `f() { …; }` 形式 |
| ANSI-C 指令字：`$'cmd' //c ver` | `$'...'` 的內容是 ANSI-C 解碼後才是指令名（`$'cmd'` → cmd，實測 native 跑 ver、轉換關閉＝banner）；掃描器把 `$'...'` 當資料複製、不做解碼，所以不命中（漏修，安全方向） | 直接寫 `cmd //c …` |
| `coproc cmd //c ver` | `coproc` 是保留字但不在指令位置續位集；`cmd` 被當參數（漏修）。Windows 上 coproc 的管道行為本身也不穩定（實測錯誤訊息亂碼且與 native 不同） | 不要把 coproc 與 cmd 混用 |
| heredoc 定界符第一字是 **ASCII 標點或純數字**（`<<3`、`<<*X`、`<<.E`、`<<$S`、`<<#`；實測都是合法 heredoc） | 掃描器不認（第一字限制）→ 本體被當指令掃描＝**資料改寫**；放寬第一字會把 `$((x<<$y))`／`$((x<<3))` 這類算術誤判成 heredoc，兩側都是猜。**非 ASCII 第一字已收錄**（`<<中文`、`<<中文EOF`、`<<·`、`<<2中文`、`<<😀` 實測是合法 heredoc；非 ASCII 不可能開算術/替換，放寬無風險——pi 2026-11-04、oc 2026-11-04 都已修） | 定界符用字母開頭（ASCII 或中文都行：`EOF`、`EOF2`、`2EOF`、`中文` 都認） |
| 需要 quote-removal／ANSI-C 解碼的 heredoc 定界符：`<<$'E\tF'`、`<<"E\"F"`、`<<E"OF"`、`<<E\OF` | 終止行取決於解碼後的 word；靜態重現不可靠。掃描器改為**整條指令原樣放行**（inert；寧可漏修，不再把本體當指令掃描） | 定界符用無轉義的字母／中文或單純引號字（`<<'END OF FILE'`、`<<$'EOF'` 都認） |
| 算術位移用識別字（`$((1<<N))`、`((x<<N))`）之後還有指令 | `<<N` 被當 heredoc 開頭、等不到定界符 → 換行後整段不再改寫（其後的 cmd 旗標／envp 全部漏修；實測 live 是靜默 banner）。與 `$((1<<2))` 同形、靜態不可分 | 位移量寫數字（`1<<1`），或把算術與後續指令分成不同次呼叫 |
| `case $x in esac) …` 的死文字 | 整行是語法錯誤（exit 2）；改寫只影響 stderr 回印的文字。**兩個 host 都已**把樣式區的 `esac` 視為空 case 的結束、把 stray `)` 視為語法錯誤 → 不再改寫（pi 2026-11-04 對齊；同一修法同時修掉 `echo $(case x in esac) cmd //c ver` 這條**真誤修**） | 不要用 `esac` 當樣式字面 |
| 重導向**前綴**後的 cmd：`> log cmd //c ver` | 這是合法 bash（重導向可前置，`cmd` 真的執行）；實測轉換關閉＝banner、native 跑 ver。修法要追「本 simple command 是否已有指令字」（`echo x > log cmd //c` 的 cmd 是 echo 的參數），為有機頻率 ~0 的形加狀態不值得 | 重導向寫在指令後面：`cmd //c ver > log`（`;`／換行後也照常改寫） |
| 重導向**前綴**後的 envp 賦值：`> log A=/c/x node` | 同一個指令位置規則；實測 native 值轉成 `C:/x`（寫進 log 的 `process.env.A`），插件不改寫＝落回 `C:\c\x` 的靜默錯位。修法同上（追指令字是否已出現） | 重導向寫在後面：`A=/c/x node > log` |
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
- **envp 前綴賦值改寫已移除（2026-11-04）**：輸入側掃描器及其 envp 改寫整體刪除；誤修風險與開放集合成本不值得保留。替代為 path-conversion-disabled 時的系統提示（Windows 形值 `VAR=C:/x`）；殘餘形仍需照正確形寫。
- **envp 殘餘形**（不再由插件改寫）——根相對路徑值、引號開頭值、清單值
  、含 `\` 的值、`export X=/c/…`（內建、argv 位置）、env 的選項交錯形（
  `env -u V X=/c/… node`——`-u` 之後的詞在參數位置；不帶選項的 `env X=/c/… node`
  已修：env 是 POSIX 外部程式、X= 參數跨 msys→native 邊界，實測原生轉換
  `C:/x`、改寫後與原生一致）、重導向交錯形（`A=/c/x > log node`）、
  緊貼形靜態前綴止於盤符（`VAR=/c$(…)`）、**動態值頭**（`A=$(echo /c/x) node`、
  ``A=`echo /c/x` node``——實測：原生（轉換開）`node` 收到 `C:/x`、本機（轉換
  關）值原樣抵達 `/c/x` 且被 node 當磁碟相對路徑解析成 `C:\c\x`、exit 0 靜默
  ；`$(…)`／`` `…` `` 的結果值語法無法靜態判斷，與引號開頭值同屬開放集合）、
  函式與其他 msys 程式讀回值的混合邊界
  ——原生 envp 轉換會轉（或保留值），掃描器無法靜態看到整值或參數語義。
- **引號載體內的 cmd（`bash -c 'cmd //c ver'`，單／雙引號同病，`env -i bash -c "…"` 同形
  ；電池有釘）**——同一故障深一層：掃描器視引號內為資料（單引號整段不掃、雙引號
  只遞迴 `$( )`／反引號，〈掃描器要點〉首條），`cmd //c` 原樣落地。實測：轉換開 →
  原生層把 `//c` 轉成 `/c`、`ver` 正常執行（僅版本行）；轉換關 → cmd 收到字面
  `//c` 進互動模式（版本＋版權＋提示詞、exit 0）＝靜默。靜態修法需列舉「哪些程式
  把第一個參數當腳本執行」（bash/sh -c、node -e/-p、perl -e、python -c…）＝開放
  集合的猜測，且改寫引號內容就是改資料；與「外部 wrapper 條」相關而不同——那條
  開放集合在 argv 結構，這條在引號／參數語意。
- **`time -p cmd //c ver`（`-p` 結束指令位置；電池有釘）**——保留字 `time` 本身不結束
  指令位置、緊隨的指令字有授權（`time cmd //c ver` 已修、掃描器會改寫），`-p` 佔掉
  指令字位之後 `cmd //c` 落在其後、掃描器不改寫。實測：轉換關 → cmd 收到字面 `//c`
  進互動模式（版本＋版權＋提示詞、exit 0）＝靜默；轉換開 → 原生轉換、`ver` 正常。
  靜態修法需列舉各保留字／指令的旗標何時結束指令位置（如 `time` 的 `-p`）
  ＝開放集合的猜測。
- **反斜線換行續接（`cmd \`⟨newline⟩`//c ver`；pi / oc 同形，兩邊電池都有釘）**
  ——跳脫分支把
  `\`＋換行成對併進 token，`cmd` 的指令字身分被破壞、`//c` 不改寫。實測：
  轉換開 → bash 詞法先移除續接對、`//c` 經原生轉換成 `/c`、ver 正常；轉換關
  → cmd 收到字面 `//c` 進互動模式（banner、exit 0）＝靜默。前綴賦值不受影響
  （`A=/c/x \`⟨newline⟩` node` 正確改寫：賦值詞在空白後已 commit、換行在
  跳脫對內不觸發丟棄）。env 修法＝詞法層把續接對從 token 中剔除（閉集合的
  bash 詞法規則），但跳脫對消费的上下文（引號內、heredoc 標頭行）各有不同
  語意，依「寧可漏修」先記臺。
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
  4→2）。**掃描器端要模擬它**（2026-11-04 第二輪，兩 host 同）：`isCmdTok` 用
  「transport fold＋lexer 一層」（`lexWord`）、跳脫／引號收尾用 `foldedRun` 奇偶
  ——不模擬就會把 run 2 的 `"\\$(…)"`（bash 看到的是字面）當真替換改寫＝資料
  改寫，而 run 3 的真替換反而漏修；未引號 Windows 路徑 3/4 個反斜線（真的跑 cmd）
  也會漏修。**折疊本身的位元組損失仍然不可修**（插件看不到原始位元組）。
  實務：要保位元組的 payload（heredoc 內的
  `\\`、正則、Windows 路徑字面）用 write 工具落檔或 `\134` 寫法。


**pi 掃描器稽核段已移除（2026-11-04 redesign）**：原「零效應改寫稽核（pi）」、
2026-11-03／04 兩輪重跑、第二輪交叉驗證等記錄（約 130 行）隨掃描器一併刪除，
完整過程與證據在 git 歷史（commit e5b415f 及其前的版本）。下方 oc 稽核段引用的
「pi 第二輪」「pi 同輪」等交叉參照均指該歷史內容。pi 現行機制見〈pi 版：機制〉。

**零效應改寫稽核（oc，逐條實跑）**：同一份判準套到 oc 的掃描器與路徑面，找到並
修掉下列「文字有變、行為一樣」或「改到資料」的形：

- **未引號 Windows 路徑（2026-11-04 live 重測，oc）**：event.command 經 transport
  折一層（2→1、4→2）再過 bash lexer 一層。**1–2 個反斜線**最後是 `C:Windows…`
  （不存在、127）；**3 個以上**（3/4 已實測）才是真實的 `C:\Windows\…`、cmd 真的執行（live：3/4
  都跑出 banner）。舊的 `isCmdTok` 把反斜線全刪 → 3/4 形被判成 127 → **漏修**。
  現在 oc 依序做 transport fold＋lexer 去跳脫：3/4 命中並改寫、1/2 不動；
  `\cmd`／`c\md`（1）與 `c\\md`（2）命中，`c\\\md`／`c\\\\md`（3/4）留字面 `\`
  （原生 127）→ 不動。引號詞不經 lexer 跳脫，反斜線是字面分隔符：
  `"C:\Windows\…\cmd.exe"`、`"/c/Windows\…"` 實測會跑 cmd，照樣命中（`"c\md"`
  的 basename 是 `md`，不命中）——各形都有釘樁。**pi 同輪套用同一個模型**
  （`lexWord`＝fold＋lexer：3/4 命中、1/2 不動、`c\\\md`（event 3）回到不動；
  見上節 pi 第二輪）。
- **雙引號／ANSI-C 的反斜線奇偶（2026-11-04 live，oc）**：transport 先折 `\\`，
  舊掃描器卻在 event 字串上成對消費 → event 2 的 `echo "\\$(cmd //c ver)"`
  （native 印字面 `$(cmd //c ver)`）被改成 `$(cmd /c ver)`＝**資料改寫**；
  event 3（native 是真替換）反而漏修。現在 `backslashRun` 按 folded 奇偶判定，
  `scanDq`／`matchParen`／雙引號收尾／ANSI-C 收尾／主迴圈跳脫全部共用；
  event 2 不動、event 3/4 照常改寫。heredoc 的單引號定界符與終止行也先折疊再比
  （transport 對整條 command 生效）。**pi 同輪套用**（`backslashRun`／`foldedRun`
  同一組輔助，見上節 pi 第二輪）。
- **`builtin cmd //c`（零效應，2026-11-04 移除）**：`builtin` 只查內建表，cmd 不是
  內建 → bash 在 spawn 前就失敗；改寫旗標只改死文字。oc 現在不把 `builtin` 後的
  cmd 當程式（`builtin exec/command cmd //c` 仍照常命中，因為位置來自 exec/command）；
  pi 同輪同法（`commitTok` 裡 `prevTok === "builtin"` 就不開旗標區、也不留
  prevTokCmdPos）。
- `( … ) cmd //c`、`{ …; } cmd //c`、`if … fi cmd //c`、`while … done cmd //c`、
  `case … esac cmd //c`——原生語法錯誤（exit 2）。oc 現在把 group/subshell close
  與終止關鍵字（`fi`／`done`／`esac`／`}`）視為結束指令位置，不再改寫死文字；
  `;`／`&&`／換行後仍照常改寫（釘樁）。
- `for x in cmd //c …`、`for cmd in cmd //c`——list 是資料（實測印
  `[cmd] [//c]`）；`COMMAND_POS_CONTINUES` 只留「後面真的接指令字」的關鍵字
  （不含 `for`／`in`／`case`／`select`／`function`），不會把資料詞當指令。
- `f() cmd //c`——函式本體必須是複合指令，原生語法錯誤；oc 在 `f()` 後把
  指令位置延後到下一個詞，只有複合起始詞（`{`／`(`／`if`／`while`／`until`／
  `for`／`case`／`select`／`[[`）才開位置 → `f() cmd` 不改寫，`f() { … }`、
  `f() (…)`、`f() if …` 等真本體照常改寫（釘樁）。`function NAME { … }` 的
  名稱槽仍未追蹤＝漏修（臺帳，寫 `f() { … }` 可修）。殘餘：`f(); { … }`／
  `f() && …` 這類「本體缺失」的語法錯誤仍會被掃描（完整函式體文法需要語法器，
  不在詞法掃描器內）；合法本體都正確。
- 殘餘（明確不修）：`$((cmd //c …))`／`((cmd //c …))` 是無效算術，改寫只影響
  錯誤訊息；要 gate 它得完整區分算術與命令替換（內層 `$(cmd //c …)` 實測是
  活的，不能整段停掃）——依「不為死文字加語法器複雜度」留著，合法形不受影響。
- `echo $(case x in esac) cmd //c ver`——**這是真的行為誤修**：空 case 的
  `esac` 後面的 `)` 是外層 `$()` 的收尾，`cmd //c ver` 是 echo 的參數（實測輸出
  `cmd //c ver`）。舊的 `esac` gate 只看命令位置，兩 host 都會把 `//c` 改掉。
  oc 改成「pattern 區段也認 `esac`（排除主詞與引號樣式）」→ 不再改寫；
  **pi 已於 2026-11-04 同法修掉**（三態實測：local／native 都印 `cmd //c ver`，
  修前 rewritten 印 `cmd /c ver`；見上節 2026-11-04 重跑）。
- `case $x in esac) …` 的死文字——oc 的 stray `)` 不再開指令位置 → 不改寫；
  **pi 也在 2026-11-04 一併修掉**（同一個 `)` 分支：stack 空或 group 收尾都不
  開指令位置），電池從「改寫」pin 改成「不動」pin。
- **UNC 與旗標內斜線形（2026-11-03 抓到並已修）**：`cmd //server/share ver`
  與 `cmd //c/d/e ver` 曾被旗標正則改寫（終止字類 `(?![\w.-])` 少 `/`）。
  前者四態全 banner＝零效應改寫（spec 此前聲明「掃描器跳過＋電池釘樁」，實查
  電池只有 path 工具面的 pin，聲明失真）；後者本地行為翻轉（原形＝banner、
  改寫＝`系統找不到指定的路徑`，native 兩態皆 banner＝改寫≠原生）。終止字類
  補 `/` 之後兩形都不改寫，`///c` 由 curTok 非空閘擋住；電池補掃描器面三條 pin
  （UNC、`//c/d/e`、`///c`）。
- **`<<2EOF` 資料改寫（2026-11-03 抓到並已修，oc）**：數字開頭未引號定界符是合法
  bash heredoc（`<<3` 純數字實測也合法），此前不認得 → 本體被當指令掃描，
  實測觸發（本 session 頂層呼叫的本體 `cmd //c ver` 被改成 `cmd /c ver`）。
  定界符正則改為 `\d*[A-Za-z_…]`（純數字仍不認，與算術靜態同形，記邊界）。
  **pi 同源掃描器同病灶，已於 2026-11-03 移植同一條正則**（live 端到端：安裝中的
  0.6.3 本體被改成 `cmd /c ver`、0.6.5 本體保真；詳見〈掃描器要點〉heredoc 段）。
- **heredoc 解析器（2026-11-04，oc；pi 的 `<<中文` 修正同步）**：把單一 regex 換成
  `readHeredocHead`＋佇列，修掉三類**資料改寫**（每一類都先在 live oc 重現）：
  - 非 ASCII 定界符（`<<中文`、`<<·`、`<<😀`、`<<2中文`）：合法 heredoc，先前本體
    被改寫。第一字類收 `\u0080-\uFFFF`（pi 同日已修）。
  - 一行多個 heredoc（`cat <<A <<B`）：先前單槽追蹤在第一個本體遇到等於 B 的行就
    提前結束、改寫第二個本體；現在按開啟順序逐個吃本體。
  - ANSI-C／locale 引號定界符（`<<$'EOF'`、`<<$"EOF"`）：先前不認 → 本體被改寫；
    現在認得（無轉義時）。含轉義的引號定界符（`<<$'E\tF'`、`<<"E\"F"`、`<<E"OF"`）
    無法靜態重現終止行 → **整條指令原樣放行**（inert，安全方向）。
  - `$'...'` 字串本身：`$'x\' ; cmd //c ver'` 先前在 `\'` 提前結束引號、把後半當
    指令改寫；現在整段照 ANSI-C 規則找真正的收尾引號並原樣複製。
  - `case` 的 `;&`（fallthrough）也回到 pattern 區（先前第二個 body 的旗標漏修）。
- **2026-11-04 oc live 對照（WSL bash 5.3.0＋Windows git-bash 2.56.0）**：本輪
  165 條結構語料（heredoc／引號／巢狀替換／命令位置）＋122 條 heredoc/quote
  三態比對，語意差異只剩文件已記的邊界（`<<3`／`<<*X`／`<<.E`／`<<$S` 本體掃描、
  `$((1<<N))` 之後漏修、裸 `\$(` 的 native 語法錯誤、CRLF 終止行在 WSL 與
  git-bash 的差異）。CRLF 判定以 git-bash 為準（實測 `EOF\r` 會終止本體；WSL
  不會），這是 host 通道差異、不是插件 bug。
- **統計與改寫同源**：oc 的 temp 分類只有一份 `TEMP_FAMILIES`／`splitTempPath`，
  `rewritePathFix` 一次回傳值＋機制；`glob`／`patch`／`workdir` 都用同一份結果。
  `bumpFix` 只在值真的變了的分支呼叫；`bumpTool` 是分母，不是修復。兩個 host
  都不再有 UI 通知（pi 早期版本會 `ctx.ui.notify` 提示，2026-11-03 依「提示是給
  人看的、對 agent 沒有作用」移除），因此不存在「只提示、不改寫」的分支。
順帶把「計數與改寫可能脫鉤」的來源清掉（這正是「只寫提示／統計、對改寫沒影響」
那類 bug 的溫床）：

- temp 族的 regex 原本在 `rewritePath` 與 `classifyTempFix` 各一份（新增形態只
  改一邊 → 動作出現、卻計進錯的鍵）。現在 `splitTempPath` 是唯一來源，
  `rewritePathFix` 一次回傳**值＋族別**，hook 拿同一個判斷做改寫與計數；萬一
  以後新增了不屬於 temp 族的改寫，會落在 `path.other`，不會混進別人的鍵。
- `bumpFix` 只在「真的改寫了」的分支裡呼叫（`fix.value !== input.path` /
  `cmdFlagFixed` / `envPathFixed`），計數不可能單獨觸發。
- 檢查後刪掉的死碼：pi 的 `statsSnapshot()`（沒有任何呼叫者；oc 版有自己的
  使用者，各留各的）、`rewritePath` 內殘留的舊 temp regex 區塊；而
  `classifyTempFix(...) ?? "path.tempVar"` 那個 fallback 原本會把「未分類的
  改寫」悄悄記成 tempVar（今天到不了、以後可能誤導），改成 `?? "path.other"`
  ——到得了就看得見。
- 通知一律移除（2026-11-03）：`path`／`cmdFlag`／`envPath` 的改寫提示與
  `hostGap` 的一次性警告都只給人看、對 agent 沒有作用。統計與改寫不受影響，也
  沒有「只提示、不改寫」的分支；統計檔是唯一的外部觀測點。

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

## oc 版：接線與閘門

- 路徑類：`ctx.tool.hook("execute.before")` 改 `event.input`（`path` /
  `patchText` / `glob` 的 `pattern`）——input 可就地改動、改動直達執行
  （v2.2.5 實測兩處改寫都落到 spawn 的指令行）。
- 指令類：`ctx.shell.hook("create.before")` 改 `event.command` 與 `event.cwd`。
  `event.shell`／`event.command` 先過 typeof 守門（非字串 → 整體放行，v2.2.5 實測
  **無**非字串事件——對照上方工具 hook 的同類守門是實測故障點、這裡是契約一致化：
  該 hook 拋 TypeError 會弄壞 spawn 本身（比任何漏修糟），契約外的分支一律選「外掛
  不存在時的原狀」）。
- temp 錨點問 bash 本身（`cygpath -w /tmp`）：`os.tmpdir()` 不是權威——本機對
  native 子行程 MSYS 已把 TEMP 轉成 Windows 路徑（實測），但定義 `/tmp` 的是
  shell 工具的 bash；`os.tmpdir()` 只在是真盤符路徑時當 fallback，無錨點 →
  改寫整體 inert（不猜 AppData 佈局）。
- 兩者都先驗證 `event.shell` 真的是 MSYS bash（`uname -s`，按執行檔快取），`//c`
  改寫再加一道 `$MSYS_NO_PATHCONV` 探測（presence-based：`0`／空字串也停用，
  實測——探測驗「有設」（`${VAR+x}`）而非 `=1`；同樣按 shell 快取，envp 改寫共用
  同一道閘門——轉換開啟時原生層會自己做，改寫是重複防護）。掃描器內部兩個改寫
  （cmd 旗標與 envp 路徑）**各自都吃 convOff 閘**，且匯出函式的 convOff 預設是
  `false`：沒有閘證據的直接呼叫整體 inert（不確定絕不開啟副作用；hook 探測通過
  後才傳 `true`）。任何閘門失敗 → 整體不動（不動時留在漏修臺＝環境層故障未
  修；誤修是靜默破壞正確語法，比漏修嚴重）。
- **閘門機制的精確版**（2026-11-03 停用外掛後重測）：`MSYS_NO_PATHCONV` 決定的
  不是「argv 一層、envp 另一層」的差異——它是**按次 spawn 查環境**：只要被
  spawn 的子行程環境裡帶著它（任意值，空字串也算），msys 對那次 spawn 的
  argv **與** envp 轉換就整層關閉；變數在哪一層被設上（父行程匯出、bashrc 的
  runtime export）不影響判定，bash 的啟動時刻也不特別（bashrc export 後
  再 spawn，子環境帶 NPC，一樣關）。也因此在 gate ON 的閘門語意成立：
  探測看到的 NPC 就是「該次 spawn 環境帶 NPC」，與轉換層實際關閉同義。
- **測量紀律（外掛污染事故）**：hook 只改寫 opencode 交給 shell 的**頂層**
  命令字串——載著改寫的對話環境裡「直接跑」指令不是原生對照：賦值會被外掛
  自己改掉（事故：頂層 `A=/c/x node` 印出 `C:/x` 被誤判為原生轉換，實為
  外掛改寫；由此得出「envp 改寫是 no-op」的錯誤結論，工作樹已整份錯誤移除
  後撤回）。測原生行為必須讓命令走 hook 碰不到的層——子層 spawn
  （`bash -c '…'` 的 payload、或從裸 node spawnSync bash），或停用外掛
  （`opencode.json` 移除 plugin 條目，hot-reload 立即生效）並用顯著例子
  （`A=/q/x node`：停用前印 `Q:/x`＝外掛改寫、停用後印 `/q/x`＝原生）確認
  後再量。電池的 e2e parity 判準（原生側 spawn env 刪 `MSYS_NO_PATHCONV`／
  `BASH_ENV`，與改寫側比對）本身有效——被污染的是一次性的對話實測、不是
  這條判準。

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
- `matchParen` 與 scanDq→scanBash 的相互遞迴結構上無深度上限（雙引號巢狀
  `$( ` 每層遞迴；未實測重現溢位）——病態級巢狀輸入理論上可讓 hook 拋未捕捉
  例外＝插件自己弄壞工具呼叫（比漏修糟），但有機頻率為零、指不出實測故障點
  ，依「多餘的修復都不需要」刻意不加深度上限／hook try/catch。對照地，
  `event.tool` 缺欄會直接 TypeError、連帶註解承諾的 fail-safe 失真——這個已補
  typeof 守門（電池有釘）。
- 工具覆蓋面（v2.2.5，官方 v2 文件＋本機二進位交叉核對）：host 端解析路徑的
  內建工具＝read/write/edit/glob/grep（path）＋patch（patchText）＋shell
  （workdir），無 `list`/`ls` 工具。官方文件另列實驗性 `experimental_image_generate`
  （參數含 `path`；本機二進位確認存在），其 path 解析層位置未驗證——探測不到
  就不修，待下次 e2e 或版本升級補一條 `path: ${TEMP}/x` 實測，確認 host 會建
  字面 `${TEMP}` 目錄才把該 key 加進 `PATH_TOOLS`；`session_move.directory` 屬
  工作區移動、temp 形態不太會有機出現，僅記錄。

### 掃描器要點（oc；pi 掃描器已於 2026-11-04 redesign 移除，以下規則現僅約束 oc 版）

- 單引號／雙引號內的字面 `> nul`、`cmd //c` 是資料，不動（唯一例外是「獨立
  成詞的引號指令字」以去引號形式參與指令字判定，本體仍原樣輸出；見下方 envp
  段）；雙引號內的 `$( )` 與反引號會真的執行，遞迴掃描。
- 雙引號內的跳脫序必須按 **transport 折疊後** 的奇偶判定：transport 先把每對
  `\\` 折一層，bash 才解析。event 1 個反斜線 `"\$(x)"` 是字面 `$(x)`；**event 2 個**
  `"\\$(x)"` 折成 `"\$(x)"` 也是字面；**event 3/4 個**才折成 `"\\$(x)"`＝字面反斜線
  ＋真替換。oc 用 `backslashRun`（跑長度 → folded 奇偶）在 `scanDq`／`matchParen`／
  引號收尾／ANSI-C 收尾統一判定，2026-11-04 修掉 event 2 被改寫成 `/c` 的**資料
  改寫**（live 重現：native 印 `$(cmd //c ver)`、舊版印 `$(cmd /c ver)`）。pi 掃描器
  仍用 event 成對消費，尚未套用（同一 transport，記臺帳）。裸 `\$(` 原生即語法
  錯誤（大聲、exit 2，實測），改寫前後失敗同形、非誤修。
- heredoc 本體是資料；終止符照 bash 規則整行等值比對（`<<-` 先去前導 tab）、不用
  `trim()`（提早結束會讓本體被當指令改寫）；只容許行尾一個 `\r`（CRLF 等價）。
- 定界符是 bash 的 word：`<<'END OF FILE'`（引號內任意內容）、`<<\EOF`（跳脫＝
  字面化）、**空引號 `<<""`／`<<''`**（定界符是空字串、終止行＝空行，實測合法）
  都算；**未加引號的定界符可含任意非元字元字元**——`/ # $ = : * [ ]` 都實測
  合法（`<<EOF/x` 的終止行就是字面 `EOF/x`）。兩者都必須認得：字元類窄了或
  引號分支要求至少一字元，本體就會被當指令掃描（＝改到資料，實測踩過
  `cat <<""` 把 heredoc 本體裡的 `cmd //c` 改了）。
  **數字開頭定界符（2026-11-03 補，pi 同日移植）**：`<<2EOF`／`<<-2ND`／
  `<< 2EOF`／`<<\2X` 都是合法 bash heredoc（實測），定界符正則改為「詞內必須
  含字母/底線」（`\d*[A-Za-z_…]`）——此前數字開頭不認得，本體被當指令掃描、
  本體內的 `cmd //c` 遭改寫（＝資料改寫）。**兩個 host 現在都是這條正則**：pi
  於 2026-11-03 移植，依據是 live 端到端證據（安裝中的 0.6.3 用 bash 工具跑
  `cat <<2EOF…`，本體輸出真的是 `cmd /c ver`，`<<'EOF'` 對照組保真）＋拋棄式
  副本改同一行後的對照（本體保真、`$((1<<2))` 算術與 `<<<` 行為不變、電池
  全綠）；patch 上到安裝副本後已 live 複驗（0.6.5：`cat <<2EOF` 本體保真、
  `<<3` 仍掃、`cmd\\` 不觸發改寫）。
  **靜態邊界（兩 host 同源；非 ASCII 例外已由兩邊收錄）：**
  - 第一字是 **ASCII 標點或純數字**的定界符（實測合法：`* . : = $ [ ] / @ + % ^ , ~ ! ? { } #`
    與 `<<3`）不認——本體會被當指令掃描（＝資料改寫，是誤修不是漏修）。
    放寬第一字會把 `$((x<<$y))`／`$((x<<3))` 這類算術誤判成 heredoc（兩側都是猜），所以留著
    並在電池釘住「現況」。oc live 複驗（2026-11-03）：`<<3`／`<<.E` 在外掛 ON 時
    本體 `cmd //c ver` 遭改寫成 `cmd /c ver`（資料改寫實證）、OFF 原樣；`<<*X` 被
    host 的 Portable scanner 整體擋下（見 oc 接線段），兩側都到不了插件掃描器——
    這三形的「本體不應被掃」判準不變，電池照釘現況。
    例外（**2026-11-04 兩 host 都已修**）：非 ASCII 第一字（`<<中文`、`<<中文EOF`、
    `<<·`、`<<2中文`、`<<😀` 實測都是合法 heredoc）——非 ASCII 不可能開算術（識別字
    是 ASCII）或 `$(`，所以放寬到 `\u0080-\uFFFF` 無風險；先前本體被當指令掃描＝
    資料改寫（oc 已 live 重現並修正）。
  - **一行多個 heredoc**（`cat <<A <<B`）：兩個 host 舊版都用單槽追蹤，第一個本體
    遇到等於第二個定界符的行就提前結束、改寫第二個本體（oc 2026-11-04 live 重現）。
    oc 改成佇列、按開啟順序吃本體；pi 尚未移植（同一顆 bash 的語法事實，但 pi 的
    修正需另做 live 驗證，本輪不動 pi）。
  - **ANSI-C／locale 引號定界符**（`<<$'EOF'`、`<<$"EOF"`）：合法 heredoc；舊版不認
    → 本體被改寫。oc 現在認得（無轉義時）。含轉義的引號定界符（`<<$'E\tF'`、
    `<<"E\"F"`、`<<E"OF"`、`<<E\OF`）靜態不可靠 → 整條指令原樣放行（inert）。
  - 反方向：`$((1<<N))`／`((x<<N))` 的識別字運算元被當 heredoc 開頭、等不到
    定界符 → 換行後整段不再改寫（＝其後的 cmd 旗標與 envp 全部漏修；live 是
    靜默 banner，oc live 複驗 2026-11-03 同形）。與 `$((1<<2))` 同形、靜態不可分，
    記臺帳；電池釘「下一行保持原樣」。
- 跳脫字元屬於當前詞（`\>` 不構成運算子）；`2>&1` 的 `&` 不是分隔符。
- POSIX 語法關鍵字（if/then/do/{/！…）、`FOO=bar` 前綴與 env/exec/command/
  builtin（後接指令字的閉集合）不結束指令位置；`#` 在詞首是註解——bash 忽略
  該行其餘，註解本文是到不了任何程式的死資料，掃描器**原樣抄到行尾、完全不掃**
  （此前註解被 token 化：註解內的 `(` 被當函式定義重開指令位置，`cmd //c ver #
  note (cmd //x)` 連註解裡都被改寫＝零效果的誤修，已修＋雙 host 電池釘樁）。
  詞首照 bash 自己的 lexer 規則：輸入開頭或接在空白／運算子之後才是詞首——
  引號或**替換**關閉後詞延續（`"a"#b`、`$(pwd)#z`、`$((1))#z`、`<(true)#z`
  的 `#` 是字面，實測）、群組／子殼／函式／算術指令 `)` 與 case 樣式 `)` 之後
  開新詞（`(true)#c`、`((1))#c`、`f()#c`、`a)#c` 是註解，實測）；替換與群組
  都是 `)`，差別在括號堆疊的 kind（見下一條）。`}` 不做詞首：實測
  `{ true; }#c` 的 `#` 不是註解（bash 把它當字的一部分、整行語法錯誤），所以
  `}` 後照資料處理才與原生一致。註解同樣讓前綴賦值收尾成 standalone（丟棄
  暫存）。
- 重導向目標與 `)` 之後清掉指令上下文：目標是 bash 自己解析的路徑，不是 argv。
- 括號／反引號收尾要還原外層位置：`count=$(…) cmd`（賦值前綴）vs `echo $(…) cmd`
  （cmd 是參數）；詞是否**延續到括號外**由堆疊 kind 決定：替換（`$( )`、`$(( ))`）
  與程序替換（`<( )`、`>( )`）收尾＝延續（`$(pwd)#z`、`<(true)#z` 的 `#` 是字面，
  實測），群組／子殼／函式定義收尾＝開新詞（`(true)#c`、`a)#c` 的 `#` 是註解）；
  兩張平行堆疊（位置一份、kind 一份）會漂移，用單一 `{kind, pos}` 堆疊。
  **群組 `)` 不重開命令位置**（`( … ) cmd` 原生就是語法錯誤，實測 exit 2）：
  pi 版照此不改寫死文字，oc 版會把那個 `cmd //c` 也改掉——同一顆 bash、判斷
  不同，這是 pi 的刻意選擇（每項改寫要指名故障點，死文字沒有）。
  case 樣式的 `)` 沒有對應的 `(`，照 bash 語法追蹤
  case/in/esac/;; 區段，防止樣式 `)` 偷走外層 `$( ` 的堆疊項。`esac` 與
  `case` 同樣只認**命令位置**（`echo esac` 的資料詞不結束區段——實測
  `echo $(case b in a) echo esac;; b) cmd //c ver;; esac)` 是合法形，先前未
  gate 時後面的樣式 `)` 偷走外層 `$(` 的堆疊項、`cmd //c` 漏修（轉換關閉下
  靜默進互動），已修＋釘樁；`case esac in "esac") …` 的 case 主詞與引號樣式
  字面也不是終止符——oc 的 `in` 屬關鍵字集、保留指令位置，所以還要靠
  `casePending`（主詞）與 `quotedTok`（引號樣式）排除，否則 `$()` 內同樣
  漏修，已修＋釘樁；`case $x in esac)` 的樣式字面 esac 在 bash 是
  語法錯誤，實測兩種轉換狀態皆 error——掃描器照語法繼續追蹤、改寫落在死文字
  上；exit code 與原生同為 2，但 bash 的 stderr 會回印被改寫後的那一行
  （死文字改寫，零語意影響）。
- 替換／分隔符收尾清 token 狀態：替換內累積的 token 不能授權外面的改寫。
- 前綴賦值路徑改寫（**oc 已落地；pi 已於 2026-11-04 redesign 移除**）：指令位置的賦值
  token 暫存（記下在 out 的跨度
  ），真指令字落地才套用——非賦值（含空值 `B=`）、非語法關鍵字、非
  BUILTIN_WORD（bash 內建與 bash/sh：值不經 msys→native 邊界——實測
  `A=/c/x eval 'echo $A'`、`A=/c/x bash -c 'echo $A'` 原生皆 [/c/x]；eval 的
  動態範圍内 spawn native 時原生會轉〔實測 C:/x〕，排除＝該側漏修、方向
  安全）、非純數字詞（fd 前綴；實測 `A=/c/x 2>&1` 原生持久化 [/c/x]）。
  收尾＝standalone 賦值 → 丟棄：分隔符／背景 `&`／換行／重導向（含 fd 前綴）
  ／heredoc／EOF／詞首 `#` 註解。`$(` 關閉還原到指令位置時不丟（緊貼形
  `VAR=/c/x$(…)` 的值組合由後面的指令字收尾）；組合律前提＝動態尾部以 / 開頭
  （否則原生把整值當根相對路徑——實測 `A=/c$(echo foo)` 原生 → msys 根/cfoo）。
  盤符形錨點是**字母通用**（實測 /m /b /q /x /y /z 皆經 mount 表轉換：
  `A=/m/x node` → `M:/x`），**正常形**的轉換輸出＝大寫盤符＋正斜線、與原生
  bit-identical（pin 測試＋e2e 電池把原生側 env 的 `MSYS_NO_PATHCONV`／`BASH_ENV`／`PWD`
  刪掉當判準：改寫後輸出≡原生轉換輸出；`PWD` 是環境相依值——harness 可能
  匯出 Windows 形，`$(pwd)` 會因此與改寫無關地發散，兩側都隔離掉）。
  **例外（2026-11-04 量到）**：冗餘段不被正規化——MSYS 把 `//` 縮成 `/`、
  去掉 `.` 段（`A=/c//x`→`C:/x`、`A=/c/./x`→`C:/x`、`A=/c/x//y`→`C:/x/y`），
  掃描器只做前綴替換（→`C://x`、`C:/./x`、`C:/x//y`）——Windows 路徑語意等價、
  字串不同；要對齊得在此重實作路徑正規化（誤修風險大於收益），記邊界不修。
  /tmp 形→cygpath 錨點。殘餘邊界
  如實記錄：函式名與其他 msys 程式（git/cat…）是開放集合且為混合邊界
  ——body/動態範圍内 spawn native 時原生會轉（實測 `f(){ node …; };
  A=/c/x f` → C:/x，與改寫一致）、直接讀值時原生不轉（實測 → [/c/x]、
  改寫發散）；維持套用偏向 spawn 情形、讀值情形為罕見且靜默的誤修；重導向交錯形
  （`A=/c/x 2>&1 cmd`＝漏修）、靜態前綴止於盤符的緊貼形（`VAR=/c$(…)`＝漏修，
  暫存值 `/c$` 不符轉換規則）。引號指令字（`"bash"`、`"node"`、`"cmd"`——bash
  先做 quote removal 才解析指令字，引號不改變 word 身分）已納入 token 判定
  （pi / oc 兩 host 已落地；oc 的 `isCmdTok` 用 basename，引號 full-path
  `"…\cmd.exe" //c` 也一起命中）：獨立成詞（引號前無詞中字元）且在指令位置
  時以去引號形式參與——此前不 token 化，引號內建後的下一個詞會以指令位置
  誤觸套用（`A=/c/x "bash" -c …`＝靜默誤修：實測兩種轉換狀態原生皆印
  `/c/x`——msys→msys 邊界不轉 envp）、引號 node 形原本漏修（原生會轉換），
  現在一併修好（`A=/c/x "node"` → `A=C:/x "node"`，E2E parity 釘樁）；詞中引號
  （`A="…"` 的值引號、`ba"sh"` 組合）維持隱形＝值的引號本來就在漏修臺。
  **引號詞不當賦值前綴也不暫存**：bash 的賦值判定在 quote removal 之前，
  `"B=/c/y"` 是指令字（實測 127、訊息 `B=/c/y: No such file or directory`）；
  而且引號詞在 `out` 裡帶著前後引號、長度與 `curTok` 不同——用
  `out.length - curTok.length` 回推跨度會吃掉收尾引號（實測曾把
  `A=/c/x "B=/c/y" node x` 改成 `A=C:/x "BB=C:/y node x`＝引號配對被破壞），
  所以帶 `tokQuoted` 旗標的那一類詞只當普通指令字。
  exec/command/builtin 後的賦值形是參數
  不是前綴（bash 把 `X=/c/x` 當指令名跑、原生就大聲失敗——實測三種形皆
  127/127/1 同訊息）→ 不暫存、照普通詞結束指令位置（pi / oc 同）；env 的 X=
  參數會跨 msys→native 邊界（實測原生轉換 `C:/x`）→ 照舊暫存、由後續指令字
  觸發。裸 `A=/c/x env` 不動＝原生（env 是 MSYS 程式、msys→msys 邊界不轉
  envp——實測印 A=/c/x，非漏修）。

## oc 版：邊界判準（「什麼算合理的 edge case」）

判準不是「所有想像得到的語法」，而是「這個 host 的轉換層是否弄壞它」×「agent 實際
會不會寫」×「修了會不會改變語意」：

1. **轉換層弄壞的 → 修**：host 自己解析路徑（檔案工具 `path`、`patch` 指令行、
   `glob` 前綴、shell `workdir`）、MSYS 雙斜線旗標。這是唯一的修復對象。
2. **bash 語法與內建的變體 → 修**：關鍵字（`if/then/do/{/}`）、分隔符
   （`; && || | &`）、引號、`$( )`／反引號、`!`、`time/exec/command/env/builtin`。
   這些是 shell 語法本身，同一個故障、同一個語意，修它不改變指令的意思。
3. **外部程式的 argv 佈局 → 不修**：`timeout 10 cmd //c`、`nice`、`xargs cmd //c`、
   `sudo cmd //c`。要修就得逐一建模「哪個參數才是被執行的指令」——那正是
   AGENTS.md 禁止的「列舉所有可能工具」；界線劃在 **bash 內建/語法** 與
   **外部程式** 之間，不是憑感覺挑幾個。
4. **要執行才知道的 → 不修**：`$C //c`、alias、`eval`、`${TEMP:-/tmp}/x`——靜態
   掃描的邊界外。
5. **有機頻率為零的語法 → 已由語法規則自然涵蓋的才修**：`"cmd" //c`（引號包住
   的指令名）已隨「引號指令字 token 化」一起修（去引號後就是 `cmd`；`"` 不
   改變 word 身分），電池釘樁。絕對路徑 `C:\…\cmd.exe //c`、POSIX 路徑
   `/c/Windows/System32/cmd.exe`、跳脫 `\cmd //c` 三形現在兩個 host 都修：
   **isCmdTok 改用「bash 實際看到的字」的 basename 比對**（實測各形在轉換
   關閉時都進互動式 banner＝同一個故障）——pi 版原本比整詞、把這些形留在漏修臺，
   實測後改列修復（電池釘樁）。關鍵細節：**未引號詞裡的反斜線是 bash 的跳脫
   字元**（`\c`→`c`、`C:\Win…`→`C:Win…`），所以比對要先去掉未引號的反斜線
   （引號詞內不經跳脫，照原樣取 basename）。因此 `\cmd`、`c\md` 都命中（真會
   跑 cmd：實測 `c\md //c ver` 轉換開啟時輸出 `ver` 的正常結果），而
   `C:\Windows\…\cmd.exe`（去跳脫後是 `C:Windows…cmd.exe`、不存在）與
   `/c/Windows\System32\cmd.exe` 這兩種「路徑本身就不存在」的死文字形**不**
   改寫——它們原生 127，改寫只有文字變化、沒有任何執行效果。
   語料：引號指令名 0、全路徑 cmd.exe 0——不再為其他零頻率變體增加分支。

**語料實測（本機 opencode.log 的 508 條真實 `bash -c` 指令）**：20 條含 `cmd` +
`//`，其中只有 **2 條是真的要執行 cmd**——1 條在指令起始（已改寫），1 條躲在外部
包裝器 `timeout 10` 後面（依第 3 條不修）；其餘 18 條都是資料（`echo cmd //c ver`
對照、heredoc／commit message／JSON 內文）。**有機出現次數**：引號指令名 0、變數
指令名 0、全路徑 `cmd.exe` 0。所以驗證重點放在「欄位與語法位置」，不是想像出來的
語法變體。

**測量歸屬**：檔案工具 `/c/...` 的原生解析測於 v2.2.1，v2.2.5 只重測了 shell
`workdir`；其餘每一列都在 v2.2.5 上重跑過。

**驗證深度**：單元電池（見下方〈測試〉；純函式、含刻意不修與上述邊界）；live 驗證
是「每個表面一輪乾淨對話」，用外掛之前註冊的 probe 記錄模型原值，再對照磁碟／
輸出——不是窮舉，但每個修復至少有一條端到端證據；語料掃描用來決定「哪些形式值得
處理」。

## 使用統計（實作）

量測外掛實際命中率：清單內工具的呼叫次數（分母）與各修復的觸發次數（分子）。
分類學 pi／oc 沿用（cmdc 未實作；OpenCode 的各 surface 用同一組機制鍵；pi 的 cmdFlag／envPath 已於 2026-11-04 redesign 移除，歷史鍵保留）：

| key                                                            | 觸發點                                             | variant 合併範圍 |
| -------------------------------------------------------------- | -------------------------------------------------- | ---------------- |
| `path.tempMount` / `path.tempVar` / `path.other`               | 檔案工具 `path`（pi／oc）                          | `/tmp` 與 `/TMP`／`/tmp\foo` 同一種；`$TEMP/$TMP/$TMPDIR`、`${…}`、`%TEMP%` 同一種；`.other`＝未來未分類改寫的可見 fallback |
| `glob.tempMount` / `glob.tempVar`                              | oc：glob pattern 前綴拆分                          | 同上兩族；前綴只能落在其中一族（沒有 `.other`，glob split 只回 temp 命中） |
| `patch.tempMount` / `patch.tempVar` / `patch.other`            | oc：patch 指令行改寫                               | 同上；一次 patch 可同時 +1 兩個機制 |
| `shell.workdir.tempMount` / `shell.workdir.tempVar` / `shell.workdir.other` | oc：shell `workdir` 改寫              | 同上 |
| `shell.cmdFlag`                                                | cmd `//x` → `/x`（oc；pi 已移除，改由 cmdBanner 輸出側偵測） | `//c`、`//k`、多旗標、引號名、basename 路徑：同一個 argv 旗標轉換機制（緊貼形 `cmd//c` 不修） |
| `shell.envPath`                                                | 前綴賦值路徑值改寫（oc；pi 已移除，改系統提示）   | 碟符值與 `/tmp` 值：同一個 envp 轉換機制 |
| `shell.cmdBanner`                                              | 輸出側 cmd 互動 banner 偵測（pi）                  | 單一故障點（成功輸出＋雙行 banner 指紋）：無 variant 合併問題 |

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

**計數單位是「呼叫」不是「出現次數」**：同一個命令字串裡多個 `//c`、或多個
可轉換的賦值，`shell.cmdFlag`／`shell.envPath` 都只 +1（掃描器回傳的是布林
旗標，不是次數）。分母不受影響（本來就是呼叫次數），但讀統計時要記得分子是
「修過的命令數」，不是「修過的旗標／值個數」——要數實際修了幾個就得看命令
本身，統計檔案只回答「這種故障在幾個命令上出現過」。pi 已按此釘樁。

- **分母** `toolCalls[tool]`：清單內工具每次呼叫 +1。gate 的實際邊界（2026-11-04
  重測後矯正文件說法）：非 win32 → 根本不安裝 hook（不計數）；Windows 上 hook
  一定計數——**探測不到 MSYS bash 時，cmd 旗標與 envp 改寫 inert，但「分母仍計數、
  temp 路徑改寫仍發生」**（錨點退 `os.tmpdir()`，不依賴 shell 探測；實測
  `EG_SHELL=System32\bash.exe` 時 `toolCalls` 仍 +1、`path.tempVar` 仍 +1、
  `cmd //c` 不改寫不計數）。先前寫的「無 MSYS bash 時整體 inert、不灌水」把兩件
  事混為一談，已改正；不改程式去 gate 分母，因為那要嘛在載入時就付 ~370ms 探測
  、要嘛在熱路徑上多 spawn 一顆行程。
- **分子** `fixes[key]`：真的改寫才 +1，以故障點為 key；同性質 variant 合併、
  不同類型分開。
- **2026-11-04 live 欄位驗證（oc v2.2.5，讀 `kv` 的
  `plugin:…:stats`）**：依序觸發四種修復，delta 各自落在正確的鍵且互不污染——
  `cmd //c echo` → `shell.cmdFlag` +1；`A=/c/x node` → `shell.envPath` +1；
  檔案工具 `read` 的 `/tmp/...` → `path.tempMount` +1；`glob` 的
  `pattern:"${TEMP}/*.txt"` → `glob.tempVar` +1（同一次 read/glob 的分母也各 +1；
  非 MSYS shell、非清單工具不計）。這也驗證了「同一機制合併、不同機制分開」
  在真實 host 的寫入路徑上成立，不只是 fake-ctx 電池。

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

## oc 版：實測記錄（v2.2.5，一次乾淨對話）

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

涵蓋（env-guard）：每一條修復、每一條刻意不修（釘死防回歸）、hook 接線（含 shell
hook 的 typeof 契約守門——無實測故障點、釘的是契約）、gate 的兩個方向（轉換開／關
的機器都能跑同一份電池）、統計的分母 gate、各 fix key、persisted 往返與
read-modify-write、畸形資料、壞 storage 韌性、並發 server 的 delta 合併／幂等
flush／合併後仍會遞增（2026-11-03 H6 修的釘樁，兩份拋棄式 module 副本共用一個
fake store 模擬兩進程）、以及 pi 首寫不雙計（2026-11-04：全新 process＋空 agent
目錄的 worker）。

執行方式見 README 的〈開發〉。

**E2E 對照（envp 家族，oc 電池內；pi 已於 2026-11-04 redesign 移除 envp 改寫，此對照現為 oc 專屬）**：不只比字串，而是把指令送進
真 bash 跑兩次——原生（把 env 的 `MSYS_NO_PATHCONV`／`BASH_ENV`／`PWD` 刪掉，
讓 MSYS 自己做 envp 轉換）與改寫後（保留本機環境），比 exit 與 stdout。`PWD`
必須兩側一起隔離：harness 可能匯出 Windows 形，`$(pwd)` 會與改寫無關地發散
（實測 `VAR=/c/x$(pwd)` 的 native 變成 `C:\xC;\Users…`）。gate ON 方向用
`MSYS_NO_PATHCONV=1` 跑同一份電池（hook 的 H 區塊與 E 區塊會真的走改寫後
spawn）。這才真正驗證「改寫規則 ≡ MSYS 的轉換規則」（`/tmp` 錨點也因此被釘住：
改寫後的值必須等於 MSYS 自己轉出的值）。cmd //c 家族不在此列（互動模式會掛，
而且那是旗標不是 envp）。另外兩個刻意另開的模組副本：沒有 `getShellConfig`
的舊宿主（驗證整體 inert、handler 不拋、不傳 ctx 也行）、worker 場景（無錨點／
探測開關）。
