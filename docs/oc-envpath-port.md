# oc 版 envp 前綴賦值移植指南

給要在 oc-plugins/env-guard 補上「bash 前綴賦值 POSIX 路徑值改寫」（`shell.envPath`）的
agent。pi 版已落地（見 pi-extensions/env-guard/index.ts 檔頭與 docs/spec.md〈掃描器要點〉
，commit cb4522a），但 **oc 環境與 pi 不同，不能直接抄 patch**——這份指南列出哪些是
「同一顆 bash 的事實」可直接沿用、哪些是「host 結構差異」必須重做、以及 pi 版兩輪
review 踩過的全部坑（每個坑都對應一條 pinned test，漏一條就是重蹈覆轍）。

## 0. 第一步：確認 oc 實際 spawn 的 bash（不做這步之前不要動手）

repo 紀律：病理主張必須在目標環境實測。pi 版所有 native 結論是在 pi 的探測路徑
（settings.shellPath → findBash）量出來的；oc 的 shell 身分是 `event.shell`（按執行檔
快取、`uname -s` 驗 MSYS 前綴）。兩者**很可能**解析到同一顆 bash，但「很可能」不是證據：

1. 在 `ctx.shell.hook("create.before")` 裡暫時記下 `event.shell` 的解析路徑，跑幾條
   真實對話指令，拿到 oc 實際用的 bash 絕對路徑。
2. 與 pi 的 `findBash()` 結果比對路徑（可加版本 `bash --version` 首行）。
3. **路徑相同** → 下方「已釘死事實」視為沿用，但仍要跑第 4 步的最小重測電池
   （成本一分鐘，把「同一顆」從推斷變成記錄）；**路徑不同** → 下方全部事實都要
   在 oc 的 bash 上重測，一條都不能沿用。

最小重測電池（全部用 `env -u MSYS_NO_PATHCONV -u BASH_ENV bash -c` 跑，對照本機
gate 開啟時的行為）：

```bash
A=/c/x node -e '...'            # 預期 C:/x（envp 轉換存在）
A=/c/x bash -c 'echo $A'        # 預期 /c/x（msys→msys 邊界不轉）
A=/c/x env                      # 預期 A=/c/x（尾端 env 不轉，非漏修）
A=/c/x eval 'echo $A'           # 預期 /c/x；A=/c/x eval "node …" 預期 C:/x
A=/c/x 2>&1                     # 預期持久化 /c/x
A=/c$(echo foo) node -e '...'   # 預期 <msys-root>/cfoo（組合律前提）
```

## 1. 已釘死的事實（同一顆 bash ⇒ 沿用；細節見 pi 版檔頭註解與 spec）

這些是 **bash 二進位行為**，與 host 無關，pi 版已逐一實測並寫進註解：

- envp 轉換是 name-agnostic 的「值語法」轉換，只發生在 msys→native 邊界。
- `A=1 (…)`、`A=1 foo() {…}`、`A=1 if…` 全是 syntax error——賦值前綴只存在於
  simple command，不需要為群組/函式定義保守。
- 內建不 spawn：純內建情形（eval 'echo $A'、read、printf、[[、[、source、cd）
  原生不轉換。**但** eval/source/函式的動態範圍內 spawn native 時原生會轉
  （混合邊界，見第 4 節 N3）。
- `2>&1` 的 fd token：賦值持久化、不轉換。
- 緊貼形組合律：`VAR=/c/x$(pwd) node` ＝ 前綴改寫＋逐字後綴，e2e 與原生逐位元
  一致（已驗 C:/x/tmp）；前提＝動態尾部以 `/` 開頭，否則原生把整值當根相對路徑
  （`A=/c$(echo foo)` → `<msys-root>/cfoo`）。
- 轉換規則只有兩個可驗錨點：`/c…`（不分大小寫入、大寫盤符出、正斜線）、
  `/tmp…`（cygpath 錨點）；清單值（`:` 分隔）、含 `\`、根相對路徑、引號開頭
  都不是這層的形態，不碰。
- 記錄在案的漏修（方向安全，照原樣）：`A=/c/x 2>&1 cmd`、`A=/c/x > log node`、
  `A=/c/x "node"`（單獨形）、`VAR=/c$(…)`（靜態前綴止於盤符）；
  記錄在案的 no-op＝原生：`A=/c/x env`（尾端）、`A=/c/x bash/sh -c`（direct-read）。

## 2. host 結構差異（不能抄 patch 的原因，逐項對照）

| 面 | pi | oc | 移植含義 |
|---|---|---|---|
| 接線 | `tool.hook` 內對 bash 指令改寫 | `ctx.shell.hook("create.before")` 改 `event.command` | 接線點不同，但改的是同一個指令字串；oc 的 hook 已存在（cmdFlag 用） |
| gate | `pathConvDisabled()`（settings.shellPath/findBash 探測） | `isMsysShell(event.shell)` + `pathConvDisabled(event.shell)`（按 shell 快取） | **oc 的 gate 已存在且正確**，沿用；勿重寫探測 |
| 掃描器回傳 | `BashScanResult {command, cmdFlagFixed, envPathFixed}` | 裸 `string`，stats 靠 `rewritten !== event.command` 歸因 | **必須改回傳結構**：否則 envp 改寫會被誤記成 `shell.cmdFlag`（見第 4 節 oc-1） |
| 關鍵字集 | `RESERVED_WORD`，大小寫敏感（刻意：大寫 ENV/ECHO 是程式名），不含 for/case/esac/in/select/function（case 另有 caseRegion 追蹤） | `SHELL_KEYWORDS`，**toLowerCase 後比對**，集合較全 | envp 的觸發判定必須大小寫敏感（pi 版已定義語意）；oc 既有的 toLowerCase 是 cmdFlag 面的歷史行為，本移植不動它，但 envp 判定不得走它（見 oc-2） |
| 暫存機制 | `pendingEnv` 跨度暫存＋多點丟棄 | 無 | 核心新增物；pi 的 patch 是對 pi 掃描器結構寫的，oc 的 token 機制（scanDq、casePending、clearTok 時機）結構不同，**要按 oc 自己的 commitTok/EOF 結構重新落點**，逐點對照 pi 的丟棄點清單（第 3 節） |
| 統計 | `getAgentDir()/env-guard-stats.json` | 官方 `ctx.storage` | 只需新增 key `shell.envPath`（spec 統計表已留位，現標「(pi)」，實作後更新） |
| 測試 | `pi-extensions/tests/env-guard/index.mjs`（stub getAgentDir） | `oc-plugins/tests/env-guard/index.mjs`（temp 複製載入、worker 隔離） | 新 pinned tests 加在 oc 電池，載入方式沿用 oc 現有骨架 |

## 3. 掃描器改動點清單（照 pi 版語意、按 oc 結構落點）

oc 的 `scanBash` 需要新增的狀態與規則（對照 pi 版同名物）：

1. `BUILTIN_WORD` 閉集合（含 `.`、`:`、`[`、`[[`、`]]`；**不含** command/exec/env/
   builtin——它們在關鍵字集裡續位轉發）＋ `bash`/`sh`（msys→msys 邊界）＋純數字詞
   （fd 前綴）。pi 版 regex 在 index.ts:548，可直接沿用字面集。
2. `pendingEnv` 跨度暫存；統一賦值判定：**暫存**要求 `/^([A-Za-z_]\w*)=(.+)$/`
   （非空值），**觸發套用**要求「真指令字」＝非賦值（含空值 `B=`）、非關鍵字
   （大小寫敏感）、非 BUILTIN_WORD、非純數字。三個判定點（keeper/套用/EOF）
   必須同一套謂詞——pi 版 P1-a 的教訓。
3. 丟棄暫存的點（每個都要在 oc 的對應位置落點）：分隔符 `;`/`|`、`&`（背景，
   注意 `2>&1` 的 `&` 不是）、換行、重導向 `>`/`<`、heredoc、詞首 `#`（在 `#`
   這個詞自己 commit **之前**丟）、EOF 收尾 standalone。
   **唯一不丟的例外**：`$(` 關閉且還原到指令位置（緊貼形 `VAR=/c/x$(…)` 靠後面的
   真指令字收尾）——pi 版就是在這裡回歸出「緊貼形被誤丟」，靠 e2e 才抓到。
4. `convertEnvPath`（pi 版 index.ts:410 起）：`/c…` 盤符形、`/tmp…` 錨點形；oc 的
   `realTempDir()` 已存在且語意相同，沿用。問不到錨點回 null＝不修。
5. 套用時 gate 複查：gate 開（轉換沒被關）→ 丟棄暫存不套用（重複防護）。oc 的
   `pathConvDisabled(event.shell)` 已按 shell 快取，直接用。
6. `$(` 與反引號遞迴：oc 走 `scanDq`/scanBash 遞迴，envPathFixed 旗標要像
   cmdFlagFixed 一樣由子掃描傳播上來。

## 4. 陷阱清單（pi 版兩輪 review 實際踩過/修掉的，每條都有 pinned test 對應）

- **P1-a**：fd token 與空值賦值觸發改寫（`A=/c/x 2>&1`、`A=/c/x B=`）——謂詞不統一。
  釘樁：`A=/c/x 2>&1`、`A=/c/x 2>/dev/null`、`A=/c/x B=` 不動；`A=/c/x B= node x`
  正確套用。
- **P1-b**：內建為指令字時套用（native 不轉換）。釘樁：eval/read/printf/`[[`/`[`/
  source 不動。**勿「補齊」command/exec/env 進 BUILTIN_WORD**——單獨形本來就不套用
  （無真指令字），轉發形靠關鍵字續位正確（`A=/c/x env node x` → `A=C:/x env node x`）。
- **N1**：`bash -c`/`sh -c` 為指令字（msys→msys 邊界，native 不轉換）。釘樁兩條。
- **N2**：`:`、`compopt` 漏出 BUILTIN_WORD。**必做**：程式化防漂移測試——黑箱跑
  `enable -a`，逐一斷言每個內建作為 `A=/c/x <builtin>` 的指令字都不觸發（pi 版
  tests 546 行起有現成寫法，oc 電池同機可直接搬）。
- **N3**：文件描述不得過度一般化：eval/source 動態範圍 spawn native 時原生會轉
  （排除＝該側漏修、方向安全）；函式是混合邊界（body spawn → 原生轉、與改寫一致；
  body 直接讀值 → 原生不轉、改寫發散），維持套用偏向 spawn 情形。spec 與註解
  照 pi 版現行措辭（spec〈掃描器要點〉段已寫好通用版，oc 實作後把「pi 版」字樣改
  為兩 host 共用）。
- **oc-1（oc 特有）**：stats 歸因。現行 `rewritten !== event.command` 會把 envp
  改寫記進 `shell.cmdFlag`。改回傳 `{command, cmdFlagFixed, envPathFixed}`，
  分別 bump；兩 flag 都 false 才不記。
- **oc-2（oc 特有）**：envp 判定的大小寫敏感。oc 的 SHELL_KEYWORDS 走 toLowerCase，
  envp 觸發判定不得沿用（`ENV=/c/x x` 的 ENV 是程式名；`A=/c/x ECHO x` 的 ECHO
  是程式名）。本移植不動 cmdFlag 面的既有行為。

## 5. 驗證要求（repo 紀律，缺一不算完成）

1. **修前修後對照**：每個釘樁案例先在 oc 現狀跑（確認漏修/誤修方向與預期一致），
   再實作、再跑綠。
2. **e2e 走真實 spawn**：至少 `A=/c/x node`（改寫後值＝native 轉換後值，逐位元）、
   `A=/c/x bash -c 'echo $A'`（direct-read 不發散）、緊貼形 `A=/c/x$(pwd) node`
   （組合律）、事件原形 no-op。用 oc 實際 spawn 的 bash（第 0 步拿到的路徑）。
3. **電池**：oc 電池新增後全綠（現 158 條起跳）；pi 256、cmdc 175 重跑確認無跨
   host 影響（本移植只動 oc-plugins/ 與 docs/）。
4. **測試位置**：oc-plugins/tests/env-guard/ 下（host 資料夾 tests/，與插件分離）。
5. **臨時探測腳本**放系統暫存目錄，用完清掉；插件檔內不留 debug 殘留。

## 6. 文檔同步

- `docs/spec.md`：〈掃描器要點〉的「oc 版尚未跟進」句、統計表 `shell.envPath`
  的「(pi)」標記、（若量測歸屬有變）〈測量歸屬〉段。
- `oc-plugins/env-guard/index.ts` 檔頭：對應 pi 版檔頭的刻意不修/殘餘邊界條目，
  措辭照 oc 檔案既有風格（英文、語氣一致）。
- README 的 oc 段落若列了修復清單，補一條。

## 7. 順序建議

第 0 步（bash 身分）→ 第 5.1 修前對照 → 第 3 節實作（含 oc-1/oc-2）→ 第 4 節
逐條釘樁 → 第 5 節驗證 → 第 6 節文檔 → 一次 commit。
實作中若任何 native 重測結果與第 1 節「已釘死事實」矛盾：停手，矛盾代表 bash
身分或環境判定有誤，回到第 0 步重新歸因——不要把新結果默默寫進實作。
