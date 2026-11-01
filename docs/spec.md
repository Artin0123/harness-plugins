# 技術規格（spec）

使用者須知（修了什麼、會看到什麼、怎麼設定、怎麼看統計）在根目錄
[`README.md`](../README.md)；這份記**技術架構、設計判準與實測證據**。通用判準
（原生執行優先、修復審查清單、驗證紀律）見 [`AGENTS.md`](../AGENTS.md)，此處不重複。

三個 host 各自實作，掃描器同源（env-guard 的 `matchParen`／`scanBash` 等），但
**每一條修復的「適用性」是在本 host 重新量過才留**：同一顆 bash 在不同 host 的
執行層下，同一個病理可能存在、也可能被 host 自己的層攔掉（例：pi 的 `/c/...` 由
自己的解析層正規化、`nul` 由 bash 映射到丟棄裝置；OpenCode 的 `/c/...` 由工具層
處理、`nul` 在本機會真的建檔——兩邊結論不同，所以兩邊都列「不修」，但理由各自
量過）。

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

pi 直接 spawn bash（沒有 cmd.exe 中介層），所以修法與 cmdc 不同：

- temp 路徑：檔案工具 host 端解析不經 MSYS 映射、不展開變數 → 改寫到
  `cygpath -w /tmp` 探測的真實 temp（與 bash 的 `/tmp` 同一錨點）。
- `cmd //c` / `//k`：bashrc 的 `MSYS_NO_PATHCONV=1` 讓雙斜線原樣抵達 cmd → 進互動
  模式（橫幅、指令沒跑、exit 0）。以子 bash 探測實際值，確認關閉才改寫；探測失敗
  不改寫。**實測**：pi 的 bash 經 `BASH_ENV` 一樣載入 bashrc、病理重現——banner 與
  `ver` 輸出幾乎同形，無修復時模型會把 banner 誤讀成指令結果（靜默錯誤答案）。

### 刻意不修（完整理由）

原生行為或模型自身錯誤，讓它壞：

- `C:\tmp`——原生寫入會成功。
- **MSYS 盤符路徑 `/c/...`**——pi 的檔案工具解析層內建 `normalizeWindowsShellPath`
  原生正確映射 `/c/Users/x`→`C:\Users\x`（含 `/mnt/d`、`/cygdrive/e`），e2e 實測
  無 `C:\c` 錯位——盤符修復只在沒有這層正規化的 host 才合理。
- 裸 `>nul`/`&>nul`/`"nul"`——實測 pi 的 bash 把 nul 映射到丟棄裝置，不建檔——
  病理在這個執行層不存在；會建檔的僅限同進程 `/dev/null` 共存的 MSYS 原生行為，
  `rm nul` 可刪。
- `<nul`——bash 直接報 ENOENT；`2>&nul`/`<&nul`——ambiguous redirect，大聲失敗。
- 其他 cmd-ism（`del`、`dir /b`、`robocopy //mir`…）——bash 沒有這些指令，大聲
  失敗、agent 自矯正。
- **原生 exe 的 posix 路徑參數**（`python /tmp/x.py`）——`MSYS_NO_PATHCONV=1` 關掉
  了對原生程式 argv 的路徑轉換，原生 exe 收到字面 `/tmp/...` 找不到檔；大聲失敗，
  agent 可用 `cygpath -w` 自癒。全面改寫 argv 會誤傷依賴 posix 形式的 MSYS 工具
  參數，誤修風險大於漏修。
- **cmd 的非 ASCII 亂碼**——cmd 照 console code page（本機 936＝GBK）編碼輸出、
  host 以 UTF-8 解碼 → 中文變亂碼。無忠實改寫：注入 `chcp 65001` 實測非確定性
  （同命令有時 UTF-8 有時仍 GBK）且會把內建訊息切英文；治本在 host 的解碼層
  （權限外）。亂碼本身是可見訊號，模型可自矯正（改用 bash 原生工具）。

通知前綴 `env-guard:`；改寫時用 `ctx.ui.notify` 告知，不擋工具執行。

## oc 版：安裝形態與體積（v2.2.5 實測）

`opencode plugin add` = 用 pacote 把 spec 解析成 **codeload tarball**（
`https://codeload.github.com/<user>/<repo>/tar.gz/<commit>`，只取一個 commit，不 clone
歷史），解開後在安裝目錄跑一次 npm install（`@opencode/Npm`，arborist，
`--prefix <安裝目錄>`）。所以**是否有依賴，全看插件的 package.json**：

| 插件 package.json | 安裝結果 |
| ----------------- | -------- |
| `peerDependencies: { "@opencode/plugin": "^2.2.0" }` | 273 套件 / 168 MB（npm 自動安裝 peer，`@opencode/plugin` 自己依賴 `@opencode/{ai,client,protocol,schema,util}` + `effect`） |
| 不宣告任何依賴（現況） | 1 套件 / 42 KB |

`Plugin.define` 是 identity（實裝 tarball 的 `dist/effect/plugin.js`：
`export function define(plugin) { return plugin }`），所以插件自己宣告一份即可，不需要
host 的執行期模組——先前本地 plugins 目錄安裝會 `ReferenceError: Plugin is not defined`，
同一個原因，已消失。載入器只要求 default export 是帶 `id` / `setup` 的物件。

附帶事實：每次 add/update 會新增 `~/.cache/opencode/npm/<key>/<timestamp>/`，舊目錄不
自動清除；`check` / `list` 由執行中的 server 回答（記憶體中的 registry），與磁碟狀態
無關，server 沒重啟就不會反映刪檔。

## oc 版：接線與閘門

- 路徑類：`ctx.tool.hook("execute.before")` 改 `event.input`（`path` / `patchText` /
  `glob` 的 `pattern`）。
- 指令類：`ctx.shell.hook("create.before")` 改 `event.command` 與 `event.cwd`。
- 兩者都先驗證 `event.shell` 真的是 MSYS bash（`uname -s`，按執行檔快取），`//c`
  改寫再加一道 `$MSYS_NO_PATHCONV` 探測（同樣按 shell 快取）。任何閘門失敗 → 整體
  不動（漏修是大聲失敗、agent 可自癒；誤修是靜默破壞正確語法）。

### 掃描器要點（pi / oc 共用語法感知規則）

- 單引號／雙引號內的字面 `> nul`、`cmd //c` 是資料，不動；雙引號內的 `$( )` 與
  反引號會真的執行，遞迴掃描。
- heredoc 本體是資料；終止符照 bash 規則整行等值比對（`<<-` 先去前導 tab）、不用
  `trim()`（提早結束會讓本體被當指令改寫）；只容許行尾一個 `\r`（CRLF 等價）。
- 定界符是 bash 的 word：`<<'END OF FILE'`（引號內任意內容）、`<<\EOF`（跳脫＝
  字面化）都算；辨識不到就會把本體當指令掃描（＝改到資料）。
- 跳脫字元屬於當前詞（`\>` 不構成運算子）；`2>&1` 的 `&` 不是分隔符。
- POSIX 語法關鍵字（if/then/do/{/!…）與 `FOO=bar` 前綴不結束指令位置。
- 重導向目標與 `)` 之後清掉指令上下文：目標是 bash 自己解析的路徑，不是 argv。
- 括號／反引號收尾要還原外層位置：`count=$(…) cmd`（賦值前綴）vs `echo $(…) cmd`
  （cmd 是參數）；case 樣式的 `)` 沒有對應的 `(`，照 bash 語法追蹤
  case/in/esac/;; 區段，防止樣式 `)` 偷走外層 `$( ` 的堆疊項。
- 替換／分隔符收尾清 token 狀態：替換內累積的 token 不能授權外面的改寫。

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
5. **有機頻率為零的語法 → 可修但不划算**：`"cmd" //c`（引號包住的指令名）。語法上
   可修，但實務上沒人這樣寫（語料見下），留著只增加掃描器風險。

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
分類學三 host 共用，可直接對照：

| key                  | 觸發點                      | variant 合併範圍                                          |
| -------------------- | --------------------------- | --------------------------------------------------------- |
| `path.temp`          | 檔案工具 `path` 改寫        | `/tmp`、`$TEMP/$TMP/$TMPDIR`、`${…}`、`%TEMP%` 全算同一種 |
| `glob.tempPrefix`    | glob pattern 前綴拆分（oc） | 同上                                                      |
| `patch.tempLine`     | patch 指令行改寫（oc）      | 同上                                                      |
| `shell.workdir.temp` | shell `workdir` 改寫（oc）  | 同上                                                      |
| `shell.cmdFlag`      | cmd `//x` → `/x`            | `//c`、`//k`、多旗標、緊貼形全算同一種                    |

- **分母** `toolCalls[tool]`：清單內工具每次呼叫 +1，且都在 gate 之後——統計範圍
  ＝外掛實際作用的範圍（非 win32／無 MSYS bash 時整體 inert，不灌水）。
- **分子** `fixes[key]`：真的改寫才 +1，以故障點為 key；同性質 variant 合併、
  不同類型分開。

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
  不會 rename 走彼此寫到一半的檔）。
- **任何統計失敗都吞掉**：先做完原有改寫再計數；storage 壞掉時 hook 照常註冊、
  改寫照常運作、cleanup 不拋錯；壞檔／畸形資料 shape-check + 數值轉換，絕不致命。
- oc 的 `ctx.storage.set` 寫入序列化（鏈在前一筆之後）：debounce flush 與分子
  即時 flush 可能重疊，兩個 racing 的 `set` 可能把舊快照最後落盤；錯誤照樣吞掉，
  修復路徑不 await。

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

涵蓋（env-guard）：每一條修復、每一條刻意不修（釘死防回歸）、hook 接線、gate 的
兩個方向（轉換開／關的機器都能跑同一份電池）、統計的分母 gate、各 fix key、
persisted 往返與 read-modify-write、畸形資料、壞 storage 韌性。

執行方式見 README 的〈開發〉。
