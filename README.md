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
`~/.cache/opencode/npm/git-<repo>-<hash>/<timestamp>/node_modules/`。以 `#master`
跟隨 master 分支，`opencode plugin update env.guard` 更新到最新 commit（釘版本就用
完整 commit hash）。管理指令：`opencode plugin list`（只列本地插件目錄的）／
`check`（指令安裝的看這個，顯示插件 id 與所在 commit）／`remove`。

**安裝體積**（v2.2.5 實測）：每個插件 **1 個套件 / 42 KB**。插件本體不宣告任何
依賴，也不 import `@opencode/plugin`（`define` 只是 identity 函式，各插件自己宣告
一份）。這一點是必要的：`opencode plugin add` 抓完包會在安裝目錄跑一次 npm
install，而 npm 會自動安裝 peer——先前那一行
`peerDependencies: { "@opencode/plugin": "^2.2.0" }` 實測拖進 **273 個套件 /
168 MB**（`effect` 57M、`@opentelemetry` 24M、`@opencode/*` 15M、`@redis` 12M…），
且每次 add/update 都重來一次。`oc-plugins/tests/packaging/` 釘死這個形狀。

**兩個行為細節**（同一台機器實測，v2.2.5）：

- 每次 add/update 都新增一個 `<timestamp>/` 目錄，**舊的不會自動清**——`~/.cache/opencode/npm/`
  會隨更新次數單向長大，要自己刪。
- `check` / `list` 問的是**執行中的 server**（`~/.cache/opencode/opencode-service-*.exe`，
  `service.json` 存密碼），不是磁碟：檔案刪掉後它們照樣列出舊結果（server 的 log 同時
  已記 `Package is not installed`）。要讓答案反映現實，得重啟那個 server。

本地檔案安裝（`plugins/` 目錄或 config 寫本地路徑）不需要任何 npm 安裝，插件現在也
沒有執行期依賴，所以先前那個「本地檔 import `@opencode/plugin` 會 `ReferenceError`」
的坑已經不存在。

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

| 項目                                                  | pi 版做法                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/tmp`、`$TEMP`、`$TMP`、`$TMPDIR`、`%TEMP%`、`%TMP%` | 檔案工具 host 端解析不經 MSYS 映射、不展開變數 → 改寫到 `cygpath -w /tmp` 探測的真實 temp（與 bash 的 `/tmp` 同一錨點）                          |
| `cmd //c` / `//k`                                     | bashrc 的 `MSYS_NO_PATHCONV=1` 讓雙斜線原樣抵達 cmd → 進互動模式（橫幅、指令沒跑、exit 0）。以子 bash 探測實際值，確認關閉才改寫；探測失敗不改寫 |

**刻意不修**（原生行為或模型自身錯誤，讓它壞）：`C:\tmp`（原生寫入會成功）、
MSYS 盤符路徑 `/c/...`（pi 的檔案工具解析層原生正確映射）、裸
`>nul`/`&>nul`/`<nul`/`2>&nul`/`<&nul`、其他 cmd-ism（`del`、`dir /b`、
`robocopy //mir`…）、原生 exe 的 posix 路徑參數（`python /tmp/x.py`——大聲失敗，
agent 可用 `cygpath -w` 自癒）、cmd 的非 ASCII 亂碼（無忠實改寫，亂碼本身就是
可見、可自矯正的訊號）。完整理由見 spec。

通知前綴 `env-guard:`；改寫時用 `ctx.ui.notify` 告知，不擋工具執行。

### 使用統計

統計清單內工具的呼叫次數（分母 `toolCalls`）與各修復的觸發次數（分子
`fixes`）：`path.temp`（各種 temp 寫法合計）、`shell.cmdFlag`（`//c` 多旗標
合計）。分類學與 OC 版共用，可直接對照。

儲存：`~/.pi/agent/env-guard-stats.json`（pi 官方 agent 目錄，吃
`PI_CODING_AGENT_DIR` 覆蓋），**直接開檔即看**：

```json
{
  "schema": 1,
  "since": "2025-01-01T00:00:00.000Z",
  "toolCalls": { "read": 123, "bash": 45 },
  "fixes": { "path.temp": 7, "shell.cmdFlag": 9 }
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
| `shell` 的 `command`                | `BASH_ENV` 指到的 `.bashrc` 設了 `MSYS_NO_PATHCONV=1`，`cmd //c` 原樣抵達 cmd → 進互動模式（實測 stdin 關閉時：exit 0，輸出是 banner＋版權聲明＋提示符，第一行與 `ver` 幾乎同形；GBK 編碼，沒改寫時模型會把 banner 讀成 `ver` 的答案） | 只在**指令位置**把 `//flags` 改成 `/flags`：巢狀 `$( )`／反引號／雙引號、`&&`／`;`／`\|` 串接、貼緊的 `cmd//c` 都認；資料位置（`echo cmd //c`）、heredoc、單引號內容不動      |

**刻意不修**：`C:\tmp`（合法 Windows 路徑，原生寫入本來就成功）、`/c/...` 盤符路徑
（OpenCode 工具層自己解析正確）、`nul` 重導向（bash 原生行為）、cmd 的非 ASCII 亂碼
（無忠實改寫，亂碼本身就是可見、可自矯正的訊號）。

**不適用／未涵蓋**：`experimental_image_generate` 的 `path`（本機沒有 image model，
無從實測）；`session_move` 的 `directory`（session 工具、不是檔案路徑消費者）。

### 使用統計

與 pi 版同一套分類學：分母 `toolCalls`（清單內工具，gate 之後才算）、分子
`fixes`（`path.temp` / `glob.tempPrefix` / `patch.tempLine` / `shell.workdir.temp`
/ `shell.cmdFlag`，同類 variant 合計）。

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

分子（修復觸發）即時持久化，重啟不清零；統計失敗不影響工具執行（儲存與寫入時機
的設計見 spec）。

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
