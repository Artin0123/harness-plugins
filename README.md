# harness-plugins

**Harness 插件合集**：同一套「環境修復」理念（見 [`AGENTS.md`](AGENTS.md)），各 host 各自實作、放在各自的資料夾：

| host                 | 資料夾           | 發現方式                                                         |
| -------------------- | ---------------- | ---------------------------------------------------------------- |
| Command Code（封存） | `cmdc-mods/`     | `package.json` 的 `commandcode.mods` 宣告                        |
| pi                   | `pi-extensions/` | `package.json` 的 `pi.extensions` manifest（指向目錄即整層發現） |
| OpenCode v2          | `oc-plugins/`    | `opencode plugin add` 的 `::path:` 子路徑選擇器                  |

> **封存中**：`cmdc-mods/`（Command Code host）停止維護——處理太麻煩，且對自訂模型的支援度不如其他 harness。以下 cmdc 相關章節與實測數據按最後驗證版本（command-code 1.88.x）保留，**可能為隨 host 更新失準**；pi 與 OpenCode 章節不受影響。

| 名稱                | host                 | 做什麼                                                                          |
| ------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `env-guard`         | cmdc / pi / OpenCode | 環境修復層（詳見下方各章節）                                                    |
| `system-prompt`     | cmdc                 | 用 `SYSTEM.md` / `APPEND_SYSTEM.md` 自訂或附加系統提示詞                        |
| `disable-tools`     | cmdc                 | `DISABLED_TOOLS` 常數列 tool wire name——完全不載入（不送出 schema）             |
| `chat-trim-context` | OpenCode             | `id: chat.trim-context` — 針對 `chat` agent，每次送出模型請求前清理系統提示段落 |

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


## 安裝

各 host 都是「套件（推薦）**或** 手動複製」二選一，不要重複安裝（pi 以來源識別
套件，重複宣告會載入兩份）。

**Command Code（封存）**

```bash
cmdc mods add Artin0123/harness-plugins -g            # 套件（推薦）
cp -r cmdc-mods/system-prompt  ~/.commandcode/mods/    # 手動
cp -r cmdc-mods/disable-tools  ~/.commandcode/mods/
cp -r cmdc-mods/env-guard      ~/.commandcode/mods/
```

確認 `cmdc mods list`；停用/啟用/移除 `cmdc mods disable|enable|remove ...`；
單次 session 只載入內建模組：`cmdc --safe-mode`。

**pi**

```bash
pi install git:github.com/Artin0123/harness-plugins   # 套件（推薦）
cp -r pi-extensions/env-guard ~/.pi/agent/extensions/  # 手動
```

repo 根的 `package.json` 帶 `pi.extensions` manifest 指向 `pi-extensions/`（雲端 git
安裝）。確認 `pi list`；移除 `pi remove git:github.com/Artin0123/harness-plugins`；
單次不載入擴充：`pi --no-extensions`。

**OpenCode v2**（`@opencode/plugin` V2 API）

```sh
opencode plugin add "github:Artin0123/harness-plugins#master::path:oc-plugins/env-guard"
opencode plugin add "github:Artin0123/harness-plugins#master::path:oc-plugins/chat-trim-context"
```

```sh
# 手動：複製到全域 ~/.config/opencode/plugins/ 或專案 .opencode/plugins/
cp -r oc-plugins/env-guard ~/.config/opencode/plugins/
cp -r oc-plugins/chat-trim-context ~/.config/opencode/plugins/
```

指令安裝登記到全域 `~/.config/opencode/opencode.json` 的 `plugins`，實體安裝在
`~/.cache/opencode/npm/git-<repo>-<hash>/<timestamp>/node_modules/`。
`opencode plugin update env.guard` 更新，每次 add/update 會新增一個 `<timestamp>/` 目錄且不自動清除，舊的要自己刪。

`opencode plugin list` / `check` / `remove`；`check` 比對是否有新 commit。兩個查詢
指令問的是執行中的 service（`opencode service status|stop`），server 沒
重啟就一直回舊答案；service 剛被拉起時第一跑可能回 `No package plugins found`，再跑一次即正常。手動安裝（複製到 `plugins/` 目錄）不經過 npm。

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

實測數據（command-code 1.88.0 的 inputTokens 對照）見 [`docs/spec.md`](docs/spec.md)。

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

被列名的工具**完全不進 model**：schema 不送出、執行被拒（agent 可自癒改道）、
sub-agent 也拿不到。改常數後 `/mods reload`（或新 session）生效。
實作機制（filter 接線、`run_start` 重套、空陣列行為、deferred 工具的已知缺口）：
[`docs/spec.md`](docs/spec.md)。

---

## env-guard (cmdc-mods)

**只影響 Windows。管 shell 語意的三個工具（`shell_command`、`powershell`、`monitor_command`）與檔案六件套的路徑。**
技術架構（翻譯規則、暫存腳本機制）與行為說明（會看到什麼、成本、已知缺口）：
[`docs/spec.md`](docs/spec.md)。

### 修復範圍

| 指令形態                                              | 走法                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| 開頭是 `bash` / `sh` / `zsh`                          | 直接換成 Git Bash 路徑（不經過 System32 的 WSL stub）             |
| 行內有 unix 工具（`ls`、`grep`、…）                   | 整行路由 `"C:\...\Git\bin\bash.exe" -c '<line>'`，bash 自產 UTF-8 |
| 純 cmd 指令（`dir`、`ipconfig`、…）                   | 包 `powershell -EncodedCommand`，console CP 65001 再進 cmd        |
| 輸出本來就是 UTF-8 的工具（`git`、`node`、`python`…） | 不包裝，+0ms                                                      |
| 檔案工具的 `/tmp`、`$TEMP`、`$TMP`、`c:/tmp` 開頭路徑 | 改寫到 bash 的真實 temp                                           |
| MSYS 盤符路徑 `/c/...`                                | → `C:/...`（否則 host 端靜默落在 `C:\c\...`）                     |

**刻意不修**（照原樣大聲失敗，不猜測）：`goto`、label、帶 flag 的 `if`/`for`巢狀
（`for /L` 等 cmd 原生可跑的維持 cmd wrap）、`mklink /j`、delayed expansion。

使用統計：cmdc 版未實作（host 封存）；pi / OpenCode 版見各自章節。

---

## env-guard (pi-extensions)

**只影響 Windows。管 `bash` 工具的指令與 `write`/`edit`/`read`/`grep`/`find`/`ls` 的 `path`。**
技術架構、刻意不修的完整理由與判準：[`docs/spec.md`](docs/spec.md)。

pi 直接 spawn bash（沒有 cmd.exe 中介層），所以修法不同：

需求：pi **≥ 0.48.0**（探測對象用 pi 自己匯出的 `getShellConfig`——它自 0.48.0
起 export；舊宿主上擴充會整體停用＝完全不改寫，也不會有任何提示）。

| 項目                                                  | pi 版做法                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/tmp`、`$TEMP`、`$TMP`、`$TMPDIR`、`%TEMP%`、`%TMP%` | 檔案工具 host 端解析不經 MSYS 映射、不展開變數 → 改寫到 `cygpath -w /tmp` 探測的真實 temp（與 bash 的 `/tmp` 同一錨點）                          |
| `cmd //c` / `//k`                                     | bashrc 的 `MSYS_NO_PATHCONV=1` 讓雙斜線原樣抵達 cmd → 進互動模式（橫幅、指令沒跑、exit 0）。以子 bash 探測實際值，確認關閉才改寫；探測失敗不改寫。指令位置含 env/exec/command/builtin 前綴與獨立成詞的引號指令字（`"cmd" //c`——引號不改變 word 身分），但**不含複合指令的收尾詞**（`fi`／`done`／`esac`／`}` 後接指令是語法錯誤）且 `f()` 後只認複合本體；指令字用 basename 比對，`\cmd`、`/c/Windows/System32/cmd.exe`、`"C:/…/cmd.exe"` 都是同一顆 cmd（實測三形同一個故障）。外部 wrapper 如 timeout/xargs 維持不修＝漏修臺：靜態修法需開放集合的參數結構猜測 |
| 前綴賦值的 POSIX 路徑值（`VAR=/c/...`、`VAR=/tmp/...` 後接指令字） | 原生 git-bash 的 envp 轉換（name-agnostic，只看值語法）會把值轉成 Windows 形式；本機被 `MSYS_NO_PATHCONV` 停用 → 值原樣抵達、被當磁碟相對路徑寫到 `C:\c\...`（靜默錯位）。重現該層規則改寫（盤符→`C:/...`、`/tmp`→錨點；套用只認真指令字——內建、bash/sh（msys→msys 邊界不轉）與引號內建（`A=/c/x "bash" -c`）、fd 前綴、空值賦值、standalone、引號值、清單值都不觸發，實測這些形原生不走 envp 轉換或方向安全；`env X=/c/... node` 的賦值參數會跨邊界、照樣修，exec/command/builtin 後的賦值形原生就錯、不修） |

**零效應改寫不新增**：會被改寫的輸入都真的跑過「原版 vs 改寫版」比對 exit 與
stdout（2026-11-03：88 條；2026-11-04：再加 45 條 cmd/envp＋16 條 heredoc＋22 條
envp 變體，每條在 git-bash 腳本檔跑 local（轉換關閉）、native（`env -u
MSYS_NO_PATHCONV -u BASH_ENV`）、rewritten 三態；詳細證據見 spec）。2026-11-04 的
結果：三類**真的有害**的形已修——① `echo $(case x in esac) cmd //c ver`（空 case
的 `esac` 後 `)` 是外層替換收尾，cmd 是 echo 的參數——先前改寫＝**輸出內容被改**）；
② 非 ASCII heredoc 定界符（`<<中文`、`<<·`；本體是資料，先前被當指令改寫）；
③ 收尾詞／函式本體的死文字（`fi cmd`、`done cmd`、`} cmd`、`f() cmd`、
`{ true; } cmd`——兩態都是語法錯誤 exit 2，改寫只讓 stderr 回印的那一行不同）。
零效應的形一律不動；先前留下的死文字改寫（`case $x in esac) …`）也在 11-04 一併
收掉。

**刻意不修**（回傳≡原生：原生就壞，或 host 已經處理——讓它壞，agent 看得到
真原因）：`C:\tmp`（原生寫入成功）、MSYS 盤符路徑 `/c/...`（pi 的檔案工具解析
層原生映射）、`~` 展開（host 自己做）、`nul` 重導向（bash 原生：建實體 `nul`
檔／ENOENT／ambiguous redirect）、重導向目標的 `//x`、`cmd //?`／`cmd ///c`／
`cmd //server/share`（模型錯字）、**緊貼形** `cmd//c`／`"cmd"//c`（bash 當程式名、
原生 127）、`exec/command/builtin X=…` 與引號偽賦值（原生當指令名跑）、
`del`／`dir /b`／`sc /query` 等 cmd-ism、未引號 `C:\…\cmd.exe`（跳脫吃掉反斜線、
原生 127）、`( … ) cmd …` 與 `fi cmd`／`done cmd`／`} cmd`／`f() cmd`／
`{ …; } cmd`（語法錯誤，兩個 host 都不再改寫死文字）。

**只能靠「寫對」的形**（插件不修或不該修；唯一改善途徑是改寫法——完整表在
spec〈只能靠「寫對」的形〉）：

- 原生工具的旗標：**gate ON（`MSYS_NO_PATHCONV` 有設）時寫單斜線**
  `taskkill /IM x`；`//IM` 是給「轉換開啟」環境的寫法（實測本機 `//IM` 無效、
  `/IM` 可用；原生相反）。
- 給原生 exe 的路徑用 Windows 形式（`python C:/x.py`）或先 `cygpath -w`。
- 不要在 wrapper（`timeout`/`xargs`/`nice`）或 `time -p` 之後放 `cmd //c`；
  也不要把它塞進引號 payload（`bash -c '…'`）或反斜線續接。**重導向寫在指令
  後面**：`> log cmd //c ver` 這種前置形不改寫（漏修臺：得追「本 simple command
  是否已有指令字」）。
- heredoc 定界符用**字母開頭**（ASCII 或中文都行：`EOF`、`EOF2`、`2EOF`、`中文`
  都認得）；`<<3`、`<<*X` 這種第一字是 ASCII 標點/數字的寫法認不出來（本體會被
  當指令掃描＝資料會被改）；也別用識別字當算術位移量（`$((1<<N))`）——它會被誤
  認成 heredoc 開頭，換行之後的指令全部不再改寫（漏修，安全方向）。
- `find` 的目錄要寫在 `path`：`pattern:"/tmp/*.txt"` 這種把 temp 路徑塞進
  pattern 的寫法靜默回 0 筆（host 把 pattern 原樣交給 fd、絕對 pattern 對 Windows
  全路徑永不匹配）；改寫它會把 fd 從 full-path 切成 basename 遞迴（多出子目錄、
  改語意），所以不修。
- 函式用 `f() { …; }` 形式：`function f { … cmd //c …; }` 的名稱槽沒追蹤（漏修）。
- envp 前綴值寫盤符形式（`A=C:/x`）；重導向／`env -u` 選項放到指令後面。
  （`A=/c//x`、`A=/c/./x` 這種冗餘段：原生會正規化成 `C:/x`、插件只換前綴
  （`C://x`、`C:/./x`）——路徑語意等價、字串不同，寫乾淨就好。）
- cmd 輸出 GBK 亂碼、以及指令字串裡成對反斜線被 `-c` 折一層——治療點在宿主
  （解碼層／transport），插件只能記錄；要保位元組請用 write 工具落檔。

改寫與統計都**靜默**進行：不呼叫 `ctx.ui.notify`（那些提示是給人看的、對 agent
沒有作用；2026-11-03 移除）。要觀測命中率就看下面的統計檔。

### 使用統計

統計清單內工具的呼叫次數（分母 `toolCalls`）與各修復的觸發次數（分子
`fixes`）。**key ＝故障機制**，同一機制的拼法合併、機制不同就分開：

| key | 故障機制 | 合併的 variant |
| --- | --- | --- |
| `path.tempMount` | host 不套 MSYS 掛載映射 | `/tmp`、`/TMP`、`/tmp\foo` |
| `path.tempVar` | host 不展開變數 | `$TEMP/$TMP/$TMPDIR`、`${…}`、`%TEMP%` |
| `shell.cmdFlag` | msys argv 旗標轉換被關 | `//c`、`//k`、多旗標、引號名、basename 路徑 |
| `shell.envPath` | msys envp 賦值值轉換被關 | 碟符值與 `/tmp` 值 |

舊版把 `/tmp` 與 `$TEMP` 合在 `path.temp`（兩個不同故障），已拆開；舊檔的
`path.temp` 不重新命名。分類學與 OC 版共用（OC 各 surface 已用同一組
Mount/Var 鍵），可直接對照。

儲存：`~/.pi/agent/env-guard-stats.json`（pi 官方 agent 目錄，吃
`PI_CODING_AGENT_DIR` 覆蓋），**直接開檔即看**：

```json
{
  "schema": 1,
  "since": "2025-01-01T00:00:00.000Z",
  "toolCalls": { "read": 123, "bash": 45 },
  "fixes": { "path.tempMount": 5, "path.tempVar": 2, "shell.cmdFlag": 9, "shell.envPath": 2 }
}
```

重啟不清零；統計失敗不影響工具執行（寫入時機與安全設計見 spec）。

---

## env-guard (oc-plugins)

`id: env.guard` — **只影響 Windows**（MSYS/MINGW bash）。OpenCode 的執行層與 cmdc /
pi 不同——凡是 host 自己解析（不經 MSYS 映射、不展開變數）的路徑都壞，修在工具輸入
與 shell 建立兩個邊界上。
技術架構、邊界判準、接線與閘門、實測記錄：[`docs/spec.md`](docs/spec.md)。

### 修復範圍（每一列都在 v2.2.5 實測過）

| 工具 / 欄位                         | 症狀（實測）                                                                                                                                                                                                                           | 做法                                                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read` / `write` / `edit` 的 `path` | `$TEMP/x` 在專案下建字面 `$TEMP` 資料夾；`${TEMP}/x` 同樣字面；`/tmp/x` 找不到檔案                                                                                                                                                     | `/tmp`、`$TEMP`/`$TMP`/`$TMPDIR`、`${TEMP}`（大括號）、`%TEMP%`/`%TMP%` 開頭改寫成 bash 自己回報的 temp 錨點（`cygpath -w /tmp`）；`~` 由 host 自己展開成家目錄（實測，不動） |
| `glob` / `grep` 的 `path`           | 同上（`$TEMP` 進不去真 temp）                                                                                                                                                                                                          | 同一個 `path` 改寫                                                                                                                                                            |
| `glob` 的 `pattern` 內嵌路徑        | `pattern: "${TEMP}/*.txt"` 靜默回 0 筆（假陰性）                                                                                                                                                                                       | 只在**沒有另給 `path`** 時，把前綴 temp 目錄拆到 `path`、其餘留給 `pattern`；有給 `path` 就完全不動                                                                           |
| `patch` 的 `patchText`              | `*** Add File: ${TEMP}/x` 在專案下建字面 `${TEMP}` 資料夾                                                                                                                                                                              | 只改寫 `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` 這四種指令行；patch 內容（` `、`+`、`-` 開頭）一字不動。四種都實測過（含改名與刪除）        |
| `shell` 的 `workdir`                | `workdir: /tmp` 直接失敗：`Working directory does not exist: C:\tmp`                                                                                                                                                                   | 同一個改寫（hook 收到的是未解析的原值 `event.cwd`）                                                                                                                           |
| `shell` 的 `command`                | `BASH_ENV` 指到的 `.bashrc` 設了 `MSYS_NO_PATHCONV=1`，`cmd //c` 原樣抵達 cmd → 進互動模式（實測 stdin 關閉時：exit 0，輸出是 banner＋版權聲明＋提示符，第一行與 `ver` 幾乎同形；GBK 編碼，沒改寫時模型會把 banner 讀成 `ver` 的答案） | 只在**指令位置**把 `//flags` 改成 `/flags`：巢狀 `$( )`／反引號／雙引號、`&&`／`;`／`\|` 串接、獨立成詞的引號指令字（`"cmd" //c`——引號不改變 word 身分）都認；資料位置（`echo cmd //c`）、heredoc、單引號內容不動。緊貼形 `cmd//c` 不修（bash 當程式名、原生 127 大聲＝模型錯字） |
| `shell` 的 `command`（賦值前綴）    | 同一個 `MSYS_NO_PATHCONV=1` 關掉 envp 轉換：`VAR=/c/foo node …` 的值原樣抵達，被 node 當磁碟相對路徑解析成 `C:\c\foo`（靜默錯位、exit 0）                                                                                               | 只修**指令位置賦值＋後接真指令字**的靜態未引號整值：盤符形（字母通用，`/m`、`/q` 等皆經 mount 表）→ 大寫盤符＋正斜線、`/tmp` 形 → cygpath 錨點；套用只認真指令字——內建、bash/sh（msys→msys 邊界不轉）、引號內建（`A=/c/x "bash" -c`——去引號後是內建）、fd 前綴、空值賦值、standalone、引號值、清單值都不觸發；`env X=/c/... node` 的賦值參數會跨邊界、照樣修，exec/command/builtin 後的賦值形原生就錯、不修。standalone 賦值是 shell 變數（bash 端需要 POSIX 值）＋所有丟棄點（分隔符／背景 `&`／換行／重導向／heredoc／詞首 `#`／EOF）不動 |

**刻意不修**：`C:\tmp`（合法 Windows 路徑，原生寫入本來就成功）、`/c/...` 盤符路徑
（OpenCode 工具層自己解析正確）、`nul` 重導向（bash 原生行為）、cmd 的非 ASCII 亂碼
（無忠實改寫，亂碼本身就是可見、可自矯正的訊號）、**緊貼形**雙斜線（`cmd//c`、
`"cmd"//c`——bash 把 `cmd//c` 當程式名，原生就是 `No such file or directory`／127；
插空格把一個詞拆成兩個＝替模型改錯字，沒有環境故障點）、`exec`／`command`／`builtin`
後的賦值形（`command X=/c/x node`——bash 把 `X=/c/x` 當指令名跑、原生就大聲失敗）、
原生 exe 的 POSIX 路徑參數（`python /tmp/x.py`——大聲失敗、可用 `cygpath -w` 自癒）。

**只能靠「寫對」的形**（插件不修或不該修；唯一改善途徑是改寫法——完整表在
spec〈只能靠「寫對」的形〉）：

- 原生工具的旗標：**gate ON（`MSYS_NO_PATHCONV` 有設）時寫單斜線**
  `taskkill /IM x`；`//IM` 是給「轉換開啟」環境的寫法（實測本機 `//IM` 無效、
  `/IM` 可用）。
- `cmd` 的程式名直接寫 `cmd`（或全正斜線的 `/c/.../cmd.exe`）。Windows 路徑：
  transport 先折一層、bash lexer 再去一層，所以 1–2 個反斜線的未引號
  `C:\Windows\…` / `C:\\Windows\…` 都變成 `C:Windows…`（127，不修）；**3 個以上**（3/4 已實測）
  才是真實路徑、插件會改寫旗標。pi 的 transport 折疊相同，但判準仍全刪（3/4 漏修）。
  跨 host 一致就加引號（`"C:\Windows\…\cmd.exe"` 兩邊都認）或寫 POSIX 路徑。
- 引號／ANSI-C 裡的反斜線也按同一折疊計：event 2 個 `\\` 到 bash 只剩一個
  （`"\$(…)"` 是字面），**3 個以上**（3/4 已實測）才是「字面反斜線＋真替換」。oc 已按 folded
  奇偶掃描；pi 仍用 event 成對（記錄為臺帳）。
- 給原生 exe 的路徑用 Windows 形式（`python C:/x.py`）或先 `cygpath -w`。
- 不要把 `cmd //c` 放進外部 wrapper（`timeout`/`xargs`/`nice`）、`time -p`、
  引號 payload（`bash -c '…'`）或反斜線續接；寫在指令位置。
- envp 前綴值直接寫盤符形式（`A=C:/x`）；重導向／`env -u` 選項放到指令後面。
- 子殼或 `fi`／`done`／`esac`／`}` 之後要接指令，請加 `;`／`&&`／換行
  （直接接指令字是 bash 語法錯誤）；函式本體用 `f() { …; }` 形式（
  `function f { …; }` 內的 `cmd //c` 目前漏修）。
- cmd 輸出的 GBK 亂碼——治療點在宿主解碼層。指令字串裡成對反斜線被 transport
  折一層是兩 host 共有的通道行為（oc live 2026-11-04 量到 2→1、4→2），bash lexer
  再一層；oc 的程式名判準現在完整模擬這兩層，pi 仍全刪（3/4 個反斜線的真實路徑
  漏修）。要保位元組請用 write 工具落檔或 `\134`。
- heredoc 定界符：字母／中文開頭、`<<$'EOF'`／`<<$"EOF"`、一行多個 heredoc 都認；
  含轉義的引號定界符（`<<$'E\tF'`、`<<"E\"F"`）整條指令原樣放行（inert，安全）。
  `<<3`、`<<*X` 這種第一字是 ASCII 標點/數字的寫法仍是邊界（本體會被當指令掃描）。
- host 自帶的 shell 預檢（「Portable shell scanner」）對 `cat <<*X` 一類 heredoc
  直接回 error——外掛 ON/OFF 都到不了插件（WSL bash 原生接受，回傳≠原生）；
  定界符用字母開頭可避免。

**不適用／未涵蓋**：`experimental_image_generate` 的 `path`（本機沒有 image model，
無從實測）；`session_move` 的 `directory`（session 工具、不是檔案路徑消費者）。

### 使用統計

與 pi 版同一套分類學：分母 `toolCalls`（清單內工具，gate 之後才算）、分子
`fixes`。**key ＝ surface × 故障機制**：同一機制的拼法合併、機制不同就分開；
同一個 temp 機制在每個 surface 各有一個鍵（修好 `/tmp` 的掛載映射不代表修好
`$TEMP` 的變數展開）：

| key | 故障機制 | 合併的 variant |
| --- | --- | --- |
| `path.tempMount` / `path.tempVar` | 檔案工具 `path`：host 不套 MSYS 映射／不展開變數 | 上列兩族 |
| `glob.tempMount` / `glob.tempVar` | glob pattern 前綴：同一組機制 | 上列兩族 |
| `patch.tempMount` / `patch.tempVar` | patch 指令行：同一組機制 | 上列兩族 |
| `shell.workdir.tempMount` / `shell.workdir.tempVar` | shell `workdir`：同一組機制 | 上列兩族 |
| `shell.cmdFlag` | msys argv 旗標轉換被關 | `//c`、`//k`、多旗標、引號名、basename 路徑 |
| `shell.envPath` | msys envp 賦值值轉換被關 | 碟符值與 `/tmp` 值 |

`path.other`／`patch.other`／`shell.workdir.other` 是可見的 fallback（glob split
只回 temp 命中，沒有 `.other`）：未來新增了不屬於 temp 族的改寫，會落在對應的
`.other`，不會靜默混進別人的鍵。舊 key（`path.temp` /
`glob.tempPrefix` / `patch.tempLine` / `shell.workdir.temp`）不重新命名——歷史
值照舊，新計數走新鍵。

儲存走官方 `ctx.storage`（plugin-scoped durable JSON），實體落在
`~/.local/share/opencode/opencode.db` 的 `kv` 表。查看用唯讀 SQLite（WAL 模式
下 opencode 開著也能查；schema 是 host 實作細節，僅供對帳用）：

```bash
py - <<'EOF'
import sqlite3, os
con = sqlite3.connect("file:" + os.path.expanduser("~/.local/share/opencode/opencode.db") + "?mode=ro", uri=True)
for k, v in con.execute("SELECT key, value FROM kv WHERE value LIKE '%toolCalls%'"):
    print(k, "=>", v)
EOF
```

```powershell
@'
import sqlite3, os
con = sqlite3.connect("file:" + os.path.expanduser("~/.local/share/opencode/opencode.db") + "?mode=ro", uri=True)
for k, v in con.execute("SELECT key, value FROM kv WHERE value LIKE '%toolCalls%'"):
    print(k, "=>", v)
'@ | py -
```

分子（修復觸發）即時持久化，重啟不清零；多個 opencode 並發共用同一 db 時，flush
先重讀最新値、只把自己的增量疊上去（不是整包覆蓋），計數僅 advisory；統計失敗不
影響工具執行（儲存與寫入時機的設計見 spec）。

---

## chat-trim-context (oc-plugins)

`id: chat.trim-context` — 針對 `chat` agent，每次送出模型請求前清理系統提示
（移除 `<env>` 段落）。清掃時機與機制：
[`docs/spec.md`](docs/spec.md)。

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

測試架構與涵蓋範圍見 [`docs/spec.md`](docs/spec.md) 的〈測試〉。通用判準
（原生執行優先、修復審查清單、驗證紀律）見 [`AGENTS.md`](AGENTS.md)。
