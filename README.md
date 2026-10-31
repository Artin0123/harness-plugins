# harness-plugins

**Harness 插件合集**：同一套「環境修復」理念（見 [`AGENTS.md`](AGENTS.md)），各 host 各自實作、放在各自的資料夾：

| host                 | 資料夾           | 發現方式                                                         |
| -------------------- | ---------------- | ---------------------------------------------------------------- |
| Command Code（封存） | `cmdc-mods/`     | `package.json` 的 `commandcode.mods` 宣告                        |
| pi                   | `pi-extensions/` | `package.json` 的 `pi.extensions` manifest（指向目錄即整層發現） |
| OpenCode v2          | `oc-plugins/`    | `opencode plugin add` 的 `::path:` 子路徑選擇器                  |

> **封存中**：`cmdc-mods/`（Command Code host）停止維護——處理太麻煩，且對自訂模型的支援度不如其他 harness。以下 cmdc 相關章節與實測數據按最後驗證版本（command-code 1.88.x）保留，**可能為隨 host 更新失準**；pi 與 OpenCode 章節不受影響。

| 名稱                | host      | 做什麼                                                                          |
| ------------------- | --------- | ------------------------------------------------------------------------------- |
| `env-guard`         | cmdc / pi / OpenCode | 環境修復層（詳見下方各章節）                                          |
| `system-prompt`     | cmdc      | 用 `SYSTEM.md` / `APPEND_SYSTEM.md` 自訂或附加系統提示詞                        |
| `disable-tools`     | cmdc      | `DISABLED_TOOLS` 常數列 tool wire name——完全不載入（不送出 schema）             |
| `chat-trim-context` | OpenCode  | `id: chat.trim-context` — 針對 `chat` agent，每次送出模型請求前清理系統提示段落 |

mod/extension/plugin 名稱取自資料夾名（`index.ts` 就是本體）。三個 host 都支援
「單檔」與「`index.ts` 資料夾」兩種形式；本 repo 統一用**資料夾式**，版面一致。

## package.json 佈局

每個 host 資料夾各有**自己的 `package.json`**（`cmdc-mods/`、`pi-extensions/`、
`oc-plugins/`）——名稱、說明、keywords 隨 host 各自表述，並帶各自的 manifest，
所以單一 host 資料夾可以直接安裝：`cmdc mods add ./cmdc-mods`、
`pi install ./pi-extensions`。

根目錄的 `package.json` **只保留 cmdc / pi 雲端（git）安裝必需的 manifest**、
不帶共用說明：cmdc 與 pi 的 git 套件 package root 都是 repo 根目錄
（`commandcode.mods` 與 `pi.extensions` 必須宣告在根、指向 root 內的路徑，
兩者都不支援 git 子路徑安裝）；OpenCode 不受限——它用 `::path:` 子路徑選擇器
直接指到 `oc-plugins/<插件名>/`（每個插件資料夾另有一份自己的 package.json）。


## 安裝（Command Code，二選一）

### 1. 套件（推薦）

```bash
cmdc mods add Artin0123/harness-plugins -g
```

### 2. 手動：複製資料夾

```bash
cp -r cmdc-mods/system-prompt ~/.commandcode/mods/
cp -r cmdc-mods/disable-tools ~/.commandcode/mods/
cp -r cmdc-mods/env-guard ~/.commandcode/mods/
```

> **1、2 只選一種。**

```bash
cmdc mods list        # 確認
cmdc mods disable env-guard      # 停用，檔案留著
cmdc mods enable  env-guard
cmdc mods remove  Artin0123/harness-plugins
```

單次 session 只載入內建模組：`cmdc --safe-mode`

## 安裝（pi，二選一）

### 1. 套件（推薦）

repo 根的 `package.json` 帶 `pi.extensions` manifest 指向 `pi-extensions/`（雲端 git
安裝）；單裝 pi 這個 host 也可直接指到資料夾本身（它有自己的 package.json）：

```bash
pi install git:github.com/Artin0123/harness-plugins
```

### 2. 手動：複製資料夾

```bash
cp -r pi-extensions/env-guard ~/.pi/agent/extensions/
```

> **1、2 只選一種。** pi 以來源識別套件，重複宣告會載入兩份。

```bash
pi list                                  # 確認套件
pi remove git:github.com/Artin0123/harness-plugins
```

單次不載入擴充：`pi --no-extensions`

## 安裝（OpenCode v2，二選一）

需要 OpenCode **v2** 以上（`@opencode/plugin` V2 API）。

### 1. 指令安裝（GitHub 套件 + 子路徑選擇器）

```sh
opencode plugin add "github:Artin0123/harness-plugins#master::path:oc-plugins/chat-trim-context"
opencode plugin add "github:Artin0123/harness-plugins#master::path:oc-plugins/env-guard"
```

- 登記到全域 `~/.config/opencode/opencode.json` 的 `plugins`；實體安裝在 `~/.cache/opencode/npm/`
- 以 `#master` 跟隨 master 分支，之後 `opencode plugin update <插件 id>` 更新到最新 commit；釘版本就用完整 commit hash
- 管理指令：`opencode plugin list` / `check` / `remove`——注意 `list` 只列本地插件目錄裡的；指令安裝的要用 `check` 看（會顯示插件 id 與所在 commit）

### 2. 本地檔案安裝

把插件資料夾放進 OpenCode 的插件目錄（啟動時自動載入）：

- 全域：複製 `oc-plugins/chat-trim-context/`（或 `oc-plugins/env-guard/`）到 `~/.config/opencode/plugins/`
- 專案層級：複製到專案的 `.opencode/plugins/`
- 更新就重新拉 repo 再覆蓋一次
- 本機實測（v2.2.5）：直接放進插件目錄的檔案若以 `import { Plugin } from "@opencode/plugin"` 取得 `Plugin`，會被以 `ReferenceError: Plugin is not defined` 跳過；改用上面的套件安裝則正常。堅持本地檔案安裝時，把那一行換成 `const Plugin = { define: (p) => p };` 即可（`define` 只是回傳原物件的語法糖）

> **1、2 只選一種。**

---

## system-prompt (cmdc-mods)

建立檔案就生效，沒有指令也沒有 flag：

| 檔名               | 效果                                               |
| ------------------ | -------------------------------------------------- |
| `APPEND_SYSTEM.md` | 附加在內建提示詞之後                               |
| `SYSTEM.md`        | 整份取代內建提示詞（含 identity 與安全指令，慎用） |

放這裡，先找到先用（專案優先於全域）：

```
<專案>/.commandcode/APPEND_SYSTEM.md
<專案>/.commandcode/SYSTEM.md
~/.commandcode/APPEND_SYSTEM.md
~/.commandcode/SYSTEM.md
```

兩個都有時：`SYSTEM.md` 先取代，`APPEND_SYSTEM.md` 再附加在後面。

每輪都重讀：改檔下一輪生效、不用重啟；刪檔恢復預設；檔案不存在或空白則完全不作用。位元組沒變時 prompt cache 不會破。

實測（command-code 1.88.0，inputTokens）：

| 情境                              | inputTokens |
| --------------------------------- | ----------- |
| 基準（無 mod、無檔案）            | ~16,265     |
| `APPEND_SYSTEM.md`（一行 marker） | 16,283      |
| `SYSTEM.md`（一行 marker 取代）   | 7,593       |

範例檔：[`cmdc-mods/system-prompt/SYSTEM_PROMPT.example.md`](cmdc-mods/system-prompt/SYSTEM_PROMPT.example.md)

---

## disable-tools (cmdc-mods)

清單寫在 mod 本體內——`cmdc-mods/disable-tools/index.ts` 的 `DISABLED_TOOLS` 常數，
列 tool 的 **wire name**（即 `/agents` 進階清單顯示的名稱）：

```ts
const DISABLED_TOOLS: string[] = [
	'web_search',
	'artifact_publish',
];
```

被列名的工具**完全不進 model**：schema 不送出、執行被拒（loud failure，agent
可自癒改道）、sub-agent 也拿不到——用的是 mod host 的 `setActiveTools` filter
（`withModToolFilter`），不是 permission deny（deny 只擋執行、schema 照樣進 context）。

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

## env-guard (cmdc-mods)

**只影響 Windows。管 shell 語意的三個工具（`shell_command`、`powershell`、`monitor_command`）與檔案六件套的路徑。一個 hook、每次呼叫一個決策點。**

### 每行指令走法

| 指令形態                                              | 走法                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| 開頭是 `bash` / `sh` / `zsh`                          | 直接換成 Git Bash 路徑（不經過 System32 的 WSL stub）             |
| 行內有 unix 工具（`ls`、`grep`、…）                   | 整行路由 `"C:\...\Git\bin\bash.exe" -c '<line>'`，bash 自產 UTF-8 |
| 純 cmd 指令（`dir`、`ipconfig`、…）                   | 包 `powershell -EncodedCommand`，console CP 65001 再進 cmd        |
| 輸出本來就是 UTF-8 的工具（`git`、`node`、`python`…） | 不包裝，+0ms                                                      |

路由時順手翻譯：cmd 內建（`dir`/`copy`/`del`/`rd`/`set`/`ren`/`type`/simple `if`/`for`/`mklink`）、
`%VAR%`→`$VAR`、`%ERRORLEVEL%`→`$?`、`C:\a\b`→`C:/a/b`、`2>&1` 原樣保留、
cmd 的裸 `a & b` → bash `a ; b`（依序而非丟背景）、`2>nul`/`>nul`/`<nul` → `/dev/null`。
bash 語法的 `for i in …; do …; done` 與 `if …; then …; fi` 不誤判成 cmd（段首 `do`/`done`/`then`/`fi` 是 bash 鐵證），整行原樣交給 bash；
`bash -c '…'` 的 payload 帶 cmd 活字元（`"` `%` `$(` `` ` `` `<>|&`，cmd 不認單引號）時改送暫存腳本，乾淨 payload 維持 inline。
檔案工具（write/edit/read/glob/grep/read_directory）的 `/tmp`、`$TEMP`、`$TMP`、`c:/tmp` 改寫到 bash 的真實 temp；MSYS 盤符路徑 `/c/...` → `C:/...`（否則 host 端靜默落在 `C:\c\...`）。

翻不動的（照原樣大聲失敗，不猜測）：`goto`、label、帶 flag 的 `if`/`for`巢狀（`for /L` 等 cmd 原生可跑的維持 cmd wrap）、`mklink /j`、delayed expansion。

### 會看到什麼

| 項目                                                 | 變化                                           |
| ---------------------------------------------------- | ---------------------------------------------- |
| 中文檔名、`echo` 的中文、程式輸出的中文（純 cmd 行） | 正常顯示                                       |
| 工具自己的訊息標頭                                   | 變英文，例如 `Volume in drive C has no label.` |
| unix 指令在 Windows                                  | 直接可用                                       |

指令語意不變：`&&`、`|`、`>`、`%VAR%`、引號、離開碼都跟原生 `cmd` 一致。

### 成本

路由行：bash 啟動約 +50 ms；被包裝的純 cmd 行：約 **+120 ms**（PowerShell 啟動）。UTF-8 工具跳過。

### 已知缺口

| 缺口                                | 說明                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由行內的 `cmd //c` 中文輸出會亂碼 | 內層 cmd 的 GBK 未經包裝；混合行的中文本來就沒修，路由不改這一點                                                                                   |
| 純 cmd 行超過 1800 字元不包裝       | Windows 命令列長度上限；路由行另有 7000 上限                                                                                                       |
| 覆蓋範圍                            | shell 語意的三個工具（`shell_command`、`powershell`、`monitor_command` 單字串形式走同一套路由；args 分開傳的形式原生正確，不動）＋檔案六件套的路徑 |
| Python < 3.15                       | 3.15 起預設 UTF-8；更舊的自行 `set "PYTHONIOENCODING=utf-8" &&`                                                                                    |

---

## env-guard (pi-extensions)

**只影響 Windows。管 `bash` 工具的指令與 `write`/`edit`/`read`/`grep`/`find`/`ls` 的 `path`。**

pi 直接 spawn bash（沒有 cmd.exe 中介層），所以修法不同：

| 項目                                                  | pi 版做法                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tmp`、`$TEMP`、`$TMP`、`$TMPDIR`、`%TEMP%`、`%TMP%` | 檔案工具 host 端解析不經 MSYS 映射、不展開變數 → 改寫到 `cygpath -w /tmp` 探測的真實 temp（與 bash 的 `/tmp` 同一錨點）                                                                                                                                                                              |
| `cmd //c` / `//k`                                     | bashrc 的 `MSYS_NO_PATHCONV=1` 讓雙斜線原樣抵達 cmd → 進互動模式（橫幅、指令沒跑、exit 0）。以子 bash 探測實際值，確認關閉才改寫；探測失敗不改寫。**實測**：pi 的 bash 經 `BASH_ENV` 一樣載入 bashrc、病理重現——banner 與 `ver` 輸出幾乎同形，無修復時模型會把 banner 誤讀成指令結果（靜默錯誤答案） |
| cmd + 非 ASCII                                        | 實測 cmd 輸入端在 ANSI 轉換時已毀損、輸出非 UTF-8，無法忠實改寫 → 發警告，建議改用 bash 原生工具或 PowerShell 原生命令                                                                                                                                                                               |

**刻意不修**（原生行為或模型自身錯誤，讓它壞）：`C:\tmp`（原生寫入會成功）、
**MSYS 盤符路徑 `/c/...`**（pi 的檔案工具解析層內建 `normalizeWindowsShellPath`
原生正確映射 `/c/Users/x`→`C:\Users\x`（含 `/mnt/d`、`/cygdrive/e`），e2e 實測
無 `C:\c` 錯位——盤符修復只在沒有這層正規化的 host 才合理）、
裸 `>nul`/`&>nul`/`"nul"`（實測 pi 的 bash 把 nul 映射到丟棄裝置，不建檔——
病理在這個執行層不存在；會建檔的僅限同進程 `/dev/null` 共存的 MSYS 原生行為，
`rm nul` 可刪）、`<nul`（bash 直接報 ENOENT）、`2>&nul`/`<&nul`（ambiguous
redirect，大聲失敗）、其他 cmd-ism（`del`、`dir /b`、`robocopy //mir`…）、
**原生 exe 的 posix 路徑參數**（`python /tmp/x.py`——`MSYS_NO_PATHCONV=1` 關掉
了對原生程式 argv 的路徑轉換，原生 exe 收到字面 `/tmp/...` 找不到檔；大聲失敗，
agent 可用 `cygpath -w` 自癒。全面改寫 argv 會誤傷依賴 posix 形式的 MSYS 工具
參數，誤修風險大於漏修）。

通知前綴 `env-guard:`；改寫與警告都用 `ctx.ui.notify`，不擋工具執行。

---

## env-guard (oc-plugins)

`id: env.guard` — **只影響 Windows**（MSYS/MINGW bash）。與 cmdc / pi 版同一套判準，
但 OpenCode 的執行層不同：凡是「host 自己解析、不經 MSYS 映射、不展開變數」的路徑
都壞，所以修在 host 的兩個邊界上（工具輸入與 shell 建立）。

### 修復範圍（每一列都在 v2.2.5 實測過）

| 工具 / 欄位 | 症狀（實測） | 做法 |
| --- | --- | --- |
| `read` / `write` / `edit` 的 `path` | `$TEMP/x` 在專案下建字面 `$TEMP` 資料夾；`${TEMP}/x` 同樣字面；`/tmp/x` 找不到檔案 | `/tmp`、`$TEMP`/`$TMP`/`$TMPDIR`、`${TEMP}`（大括號）、`%TEMP%`/`%TMP%` 開頭改寫成 bash 自己回報的 temp 錨點（`cygpath -w /tmp`）；`~` 由 host 自己展開成家目錄（實測，不動） |
| `glob` / `grep` 的 `path` | 同上（`$TEMP` 進不去真 temp） | 同一個 `path` 改寫 |
| `glob` 的 `pattern` 內嵌路徑 | `pattern: "${TEMP}/*.txt"` 靜默回 0 筆（假陰性） | 只在**沒有另給 `path`** 時，把前綴 temp 目錄拆到 `path`、其餘留給 `pattern`；有給 `path` 就完全不動 |
| `patch` 的 `patchText` | `*** Add File: ${TEMP}/x` 在專案下建字面 `${TEMP}` 資料夾 | 只改寫 `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` 這四種指令行；patch 內容（` `、`+`、`-` 開頭）一字不動。四種都實測過（含改名與刪除） |
| `shell` 的 `workdir` | `workdir: /tmp` 直接失敗：`Working directory does not exist: C:\tmp` | 同一個改寫（hook 收到的是未解析的原值 `event.cwd`） |
| `shell` 的 `command` | bashrc 的 `MSYS_NO_PATHCONV=1` 讓 `cmd //c` 原樣抵達 cmd → 進互動模式（GBK banner、命令沒跑、exit 0，靜默失敗） | 只在**指令位置**把 `//flags` 改成 `/flags`：巢狀 `$( )`／反引號／雙引號、`&&`／`;`／`\|` 串接、貼緊的 `cmd//c` 都認；資料位置（`echo cmd //c`）、heredoc、單引號內容不動 |

**刻意不修**：`C:\tmp`（合法 Windows 路徑，原生寫入本來就成功）、`/c/...` 盤符路徑
（OpenCode 工具層自己解析正確，`workdir` 也實測可用）、`nul` 重導向（bash 原生行為）、
cmd 的非 ASCII 亂碼（無忠實改寫，亂碼本身就是可見、可自矯正的訊號）。

**不適用／未涵蓋**：`experimental_image_generate` 的 `path`——本機沒有接上任何 image
model，工具根本不會出現，無從實測（不猜、不加）；`session_move` 的 `directory` 是 Code
Mode 的 session 工具、不是檔案路徑消費者，未列管。

**邊界（什麼算「合理的 edge case」，什麼不算）**——判準不是「所有想像得到的語法」，
而是「這個 host 的轉換層是否弄壞它」×「agent 實際會不會寫」×「修了會不會改變語意」：

1. **轉換層弄壞的 → 修**：host 自己解析路徑（檔案工具 `path`、`patch` 指令行、`glob`
   前綴、shell `workdir`）、MSYS 雙斜線旗標。這是唯一的修復對象。
2. **bash 語法與內建的變體 → 修**：關鍵字（`if/then/do/{/}`）、分隔符（`; && || | &`）、
   引號、`$( )`／反引號、`!`、`time/exec/command/env/builtin`。這些是 shell 語法本身，
   同一個故障、同一個語意，修它不改變指令的意思。
3. **外部程式的 argv 佈局 → 不修**：`timeout 10 cmd //c`、`nice`、`xargs cmd //c`、
   `sudo cmd //c`。要修就得逐一建模「哪個參數才是被執行的指令」——那正是
   AGENTS.md 禁止的「列舉所有可能工具」；界線劃在 **bash 內建/語法** 與 **外部程式**
   之間，不是憑感覺挑幾個。
4. **要執行才知道的 → 不修**：`$C //c`、alias、`eval`、`${TEMP:-/tmp}/x`——靜態掃描
   的邊界外。
5. **有機頻率為零的語法 → 可修但不划算**：`"cmd" //c`（引號包住的指令名）。語法上可修，
   但實務上沒人這樣寫（語料見下），留著只增加掃描器風險。

**語料實測（本機 opencode.log 的 508 條真實 `bash -c` 指令）**：20 條含 `cmd` + `//`，
其中只有 **2 條是真的要執行 cmd**——1 條在指令起始（已改寫），1 條躲在外部包裝器
`timeout 10` 後面（依第 3 條不修）；其餘 18 條都是資料（`echo cmd //c ver` 對照、
heredoc／commit message／JSON 內文）。**有機出現次數**：引號指令名 0、變數指令名 0、
全路徑 `cmd.exe` 0。所以驗證重點該放在「欄位與語法位置」，不是想像出來的語法變體。

**測量歸屬**：檔案工具 `/c/...` 的原生解析測於 v2.2.1，v2.2.5 只重測了 shell
`workdir`；其餘每一列都在 v2.2.5 上重跑過。

**驗證深度**：單元電池 80 項（純函式、含刻意不修與上述邊界）；live 驗證是「每個表面
一輪乾淨對話」，用外掛之前註冊的 probe 記錄模型原值，再對照磁碟／輸出——不是窮舉，
但每個修復至少有一條端到端證據；語料掃描用來決定「哪些形式值得處理」。

**血緣**：掃描器與 cmdc / pi 版同源（`matchParen`／`scanBash` 等），但每一條修復的
「適用性」是在本 host 重新量過才留：pi 的 `/c/...` 由自己的解析層正規化、`nul` 由
bash 映射到丟棄裝置；OpenCode 的 `/c/...` 由工具層處理、`nul` 在本機會真的建檔——
兩邊結論不同，所以兩邊都列「不修」，但理由各自量過。

### 接線與閘門

- 路徑類：`ctx.tool.hook("execute.before")` 改 `event.input`（`path` / `patchText` /
  `glob` 的 `pattern`）。
- 指令類：`ctx.shell.hook("create.before")` 改 `event.command` 與 `event.cwd`。
- 兩者都先驗證 `event.shell` 真的是 MSYS bash（`uname -s`，按執行檔快取），`//c`
  改寫再加一道 `$MSYS_NO_PATHCONV` 探測（同樣按 shell 快取）。任何閘門失敗 → 整體不動
  （漏修是大聲失敗、agent 可自癒；誤修是靜默破壞正確語法）。

### 實測（v2.2.5，一次乾淨對話）

模型的原始輸入（外掛在 `execute.before` 之前記到的原值）與最終落點：

| 步驟 | 模型送出的原值 | 結果 |
| --- | --- | --- |
| write | `path: $TEMP/oc-g2.txt` | 落在真實 `C:\Users\artin\AppData\Local\Temp`，專案下無字面 `$TEMP` |
| write | `path: ${TEMP}/oc-g4.txt` | 同上（大括號形式） |
| write | `path: $TMPDIR/oc-g8.txt` | 同上 |
| write | `path: ~/oc-g6.txt` | `C:/Users/artin/oc-g6.txt`（host 原生展開 `~`，不動） |
| read | `path: /tmp` | 列出真實 temp 的 1951 個項目 |
| glob | `pattern: ${TEMP}/*.txt`（無 path） | 修正前 0 筆；修正後 100+ 筆（含真 temp 的 txt） |
| patch | `*** Add File: ${TEMP}/oc-g9.txt` | 修正前建字面 `${TEMP}` 資料夾；修正後落在真實 temp |
| patch | `*** Update File: ${TEMP}/oc-m1.txt` + `*** Move to: ${TEMP}/oc-m2.txt` + hunk | 改名成功到真實 temp（內容 `alpha`/`gamma`/`beta`）；`Move to` 與 Add 是同一條 host 解析，未改寫會落到字面 `${TEMP}`（Add 已實測） |
| patch | `*** Delete File: ${TEMP}/oc-m2.txt` | 刪掉真實 temp 的檔案；後續 `read` 回報該真實路徑 not found |
| shell | `workdir: /tmp`、`command: pwd` | 修正前 `Working directory does not exist: C:\tmp`；修正後 `pwd` = `/tmp` |
| shell | `cmd //c ver` | spawn 行為 `-c "cmd /c ver"`，輸出 `Microsoft Windows [版本 10.0.19045.7725]` |
| shell | `cmd //c "echo hello world"` | `hello world`（引號與 payload 原樣抵達 cmd） |
| shell | `cmd //c "echo one" && cmd //c "echo two"` | `one` / `two`（兩段都改寫、`&&` 交由 bash） |
| shell | `v=$(cmd //c echo sub); echo "got:$v"` | `got:sub`（`$( )` 內也改寫） |
| shell | `cmd //c dir /b \| head -2` | 正常列出（管線後段是 bash 原生） |
| shell | `echo cmd //c ver` | 原樣 `cmd //c ver`（資料位置不動） |

---

## chat-trim-context (oc-plugins)

`id: chat.trim-context` — 針對 `chat` agent，在每次送出模型請求前（`context` / `compaction` / `generate`）清理系統提示：

- 移除 `<env>...</env>` 環境資訊段落
- 移除包含 worktree marker（`tools.opencode.session_move`）的段落

---

## 開發

```bash
node cmdc-mods/tests/env-guard/index.mjs      # cmdc 版回歸測試
node cmdc-mods/tests/system-prompt/index.mjs  # system-prompt 回歸測試
node cmdc-mods/tests/disable-tools/index.mjs  # disable-tools 回歸測試
node pi-extensions/tests/env-guard/index.mjs  # pi 版單元電池（含「刻意不修」釘死）
node oc-plugins/tests/env-guard/index.mjs     # OpenCode 版單元電池（含 hook 接線與「刻意不修」釘死）
```

需要 Node ≥ 22.6（23.6 起預設支援 `.ts`，更舊的要加 `--experimental-strip-types`）。

測試放 **host 資料夾的 `tests/` 下**、與插件資料夾分離——插件資料夾保持只含
交付物，手動安裝（`cp -r` 插件資料夾）不會把測試帶進安裝目錄；測試隨 host
歸屬一目了然，不會失聯。

通用判準（原生執行優先、修復審查清單、驗證紀律）見 [`AGENTS.md`](AGENTS.md)。
