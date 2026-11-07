# oc env-guard redesign — 決策記錄

> **狀態：已實作**（oc-plugins/env-guard/index.ts redesign＋電池重寫，2026-11-05）。
> 本文件回答兩件事：pi 的解法**為什麼**能終止那個無限 code review 迴圈（概念判準，
> 不依賴 pi 環境即可裁決），以及 oc 依同理念調整後**實際做了什麼、為什麼與 pi 的三
> 點不盡同**。交接期（redesign 前）的事實清單與陷阱記錄在 §5 保留。
> **2026-11-07 更新**：redesign 落地的兩個提示面（banner advisory、系統提示）已
> 整體移除，理由與取代方案見 §8。

---

## 1. 判準：輸出側偵測為什麼能終止迴圈（而不是「這次夠了」）

循環的病理：四天 25 個 commit、六個 misfix（`3c0e322`、`c445808`、`35a3f8b`、
`1111a5d`、`79ad81b`、`c062b4f`），每次「改對 → 另一個 case 改錯 → 再修」都由同一個
結構成本支付：**scanBash 在執行前猜 bash 語法的哪個位置會踩到環境故障**。bash 是開
放集合，「夠了」是判斷、不是機制——下一個 reviewer 總能指名一個新 case，而新 case
的可動作修法只有「動 lexer」。

pi 代理的解拆成三條，每條都是機制而非承諾：

1. **母體移除**：輸入側不再改寫指令字串。「誤修正確語法」這個失效類別在結構上
   不存在——沒有改寫器，就沒有誤修器。六個 misfix 的母體就此一次消失。
2. **開放集合改由輸出指紋接住**：新模式不再問「這串字會不會進互動模式」，而看
   「事實上進了沒」——互動 banner 有閉集合指紋（首兩個非空行 `Microsoft Windows [
   `＋`(c) Microsoft`；提示符行因 stdin 形態而異不入指紋；`cmd /c ver` 的單行正
   常輸出不命中）。wrapper、引號 payload、`time -p`、heredoc 邊角、反斜線續行、
   `coproc`、`$'cmd'`……所有漏修臺條目**同一時間結案**，因為偵測對象從語法位置
   變成事實本身。
3. **誤判代價有上界**：輸出側誤判的最壞結果是多一段 advisory 文字，指令原樣、
   零執行破壞。誤修方向在這個位置不存在，review 的主要利器（「你把對的改壞了」）
   失效。

**裁定：同意，且機制成立。** 收斂不是靠自律喊停，而是靠三件事把「可以再交辦的議
題」封死：(a) 想動 lexer 已無 lexer；(b) 新 case 的落點是閉集合 backstop，無分支
可提；(c) 剩下的輸入側修復全部是「欄位語意被宿主 API 密封」的閉集合（誤修在結
構上不可能）。替代的終止條件依然保留：任何新修復必須逐項過 AGENTS 的審查清單
（指名故障點＋兩態實測＋閉集合＋誤判代價有界），舉證責任在提案方，以判準裁定而
不是靠 flag、行數或「我覺得夠了」。

**已知成本（如實記錄，不做為回頭的理由）：**
- cmd 形從「輸入側一次過」變成「一次 banner 後一輪自癒」——少吃免費午餐、換到
  知道真相。pi 提議的 20 行窄 fast-path（僅 `^cmd //c` 行首形）是可選優化；**本
  設計不採**：任何輸入側改寫就是重建誤修母體，不為省一輪而重開它。
- 指紋是本機實抓的閉集合；被截斷或指紋不完整的 banner 漏報、放行（保守方向）。
- GBK 亂碼治療點仍在宿主解碼層（既有分界不變）。

## 2. oc 宿主能力查證（v2.2.5 標籤源碼；`gh api repos/anomalyco/opencode/contents/<path>?ref=v2.2.5`）

| 問句（交接文件 §3 的未知 ①②）                                 | 答案                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| oc 有沒有輸出側 hook？                                        | **有**。`ctx.tool.hook("execute.after")`：事件含 `result: Tool.Result` **可變**（`packages/plugin/src/effect/tool.ts:29`）；宿主執行點 `packages/core/src/tool.ts:158–173` 在 trigger 後讀 mutate 過的 `afterEvent.result` 再返回——**改動直達模型**；`step.ts` 的 truncate 在 hook 之後跑，首部存活 |
| shell 工具結果的形狀                                          | 工具名 `"shell"`（非 `bash`）；成功 path 的 `result`：`content:[{type:"text",text},…]`、`metadata:{truncated, exit?, timeout?, signal?, status?}`（`packages/core/src/tool/plugin/shell.ts`）。指紋只在 `status==="completed"`、`metadata.exit===0`、非 timeout/signal 時進入 |
| oc 能否注入系統提示？                                         | **可以**。`ctx.session.hook("context")` 的 `event.system: SystemPart[]` 可就地 push；`SystemPart = {type:"text",text}`（chat-trim-context 已在本機實證同型接線）。`compaction`／`generate` 同型，一次註冊三個 |
| 宿主已有層是否會攔？                                          | host 自帶的 Portable shell scanner 預檢不變（照 spec 老記錄；它擋的形兩側都到不了插件，記臺帳）         |

這兩個答案正是交接文件「查證前不要動手」的第一個決策點——輸出側方案在 oc 走得通，
且宿主源碼層級的證據比插件的猜測強。

## 3. oc 的實際調整（≠照抄 pi 三點）

| pi 的三點                                     | oc 的對應                                                                   | 宿主差異說明                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 檔案工具 `path` temp 改寫（1 surface）        | **保留 oc 既有的四個 surface**：`path`／`glob` 前綴拆分／`patch` 指令行／`shell` `workdir` | 不是 pi 少了、是 pi 沒有這些工具。每個 surface 都已本機實測（README 表）。閉集合、欄位語意被 host API 密封，修復位置確定、需要零判斷       |
| cmd banner 輸出側偵測＋advisory               | 新增 `execute.after` banner backstop＋`shell.cmdBanner` 統計鍵 ——**2026-11-07 隨提示面移除（§8）**                | 接線不同：pi 回傳 patch、oc 就地改 `event.result`；偵測函式同型（指紋一致、ASCII advisory）。conversion 狀態取自該次 spawn 的 `create.before` probe（per-exe cache）；spawn 未經 create.before 時沿用初始值＝「轉換開啟」語義（提 `//c`，與 pi 的 `pathConvDisabled()` probe 失敗預設同） |
| envp 輸入側掃描整座移除，改系統提示一行       | 同方向：`scanBash`／`matchParen`／`readHeredocHead`／`backslashRun`… 整套 lexer（~600 行）與對應 ~700 行電池**移除**；`ctx.session.hook("context"/"compaction"/"generate")` 在實測 `MSYS_NO_PATHCONV` 存在時注入純 ASCII 提示（前綴賦值寫 `VAR=C:/x`、native exe 旗標寫單斜線）——**系統提示已於 2026-11-07 隨提示面移除（§8）** | 提示通道不同：pi 走 `before_agent_start` 的 `promptGuidelines`、oc 走 session context hook；探測對象的等號題（「探測的 bash ≡ spawn 的 bash」）pi 用 `getShellConfig` 由構造保證、oc 由 `event.shell`＋`uname -s` 在 spawn 當場驗證——兩方向都已實測 |

**oc 端新增、pi 端沒有的束制（redesign 落地檢查）**：宿主 Portable scanner 會擋掉
部分 heredoc 形（回傳≠原生）——照老記錄留臺帳；「背景命令（`status="running"`）
不貼 advisory」的束制隨提示面移除而消亡（§8）。

## 4. 落地記錄

- `oc-plugins/env-guard/index.ts`：redesign 版 ~660 行（含統計與探測），從 1594 行
  縮下；**2026-11-07 提示面移除後 527 行**（§8）。cmd 形的輸入側完全移除：
  shell create.before 只做身分驗證＋workdir 改寫（不再碰 `event.command`；
  轉換狀態探測快取隨提示面移除，§8）。
- `oc-plugins/tests/env-guard/index.mjs`：電池重寫。保留：temp 族全表面釘樁、
  glob 分拆、patch 指令行、分類單一來源、shell 身分、統計（分母/分子/
  持久化/併發/畸形/壞 storage）、worker（無錨）、非 win32、packaging。刪除：
  scanBash 的全套釘樁（heredoc 本體、case region、函式本體、註解、引號詞、
  `\$(` 資料……）——沒有改寫器，這些測的不是行為而是死碼；等價的「還有沒有人
  改我的指令」釘樁改為 shell hook 對 `command` 永不變的單一斷言。redesign 當時
  新增的 banner 指紋／`execute.after` 契約／系統提示 marker 電池段隨提示面
  一起刪除（2026-11-07）；電池現 110 條全綠。
- `docs/spec.md`：oc 版各節改寫（機制、接線、邊界臺帳、統計表、測試段）。
- `README.md` oc 段同步。

## 5. 保留的事實與陷阱（交接期清單，全部仍然有效）

- **BASH_ENV 探針陷阱**：`MSYS_NO_PATHCONV` 經 `BASH_ENV` 對所有子 bash 生效；
  量 native 行為要 `env -u MSYS_NO_PATHCONV -u BASH_ENV`（spec 有實錄）。
- **探測對象 ≡ spawn 對象**：v2.2.5 上已本機量過 spawn 解析落點＝`findBash()`；
  換機器/版本前重測，不合則 `exec.envPathHint` 整體停用（inert，不猜 PATH）。
- **banner 指紋（量測事實，保留）：** 指紋＝輸出前兩個非空行（`Microsoft Windows [` ＋
  `(c) Microsoft`）；提示符行 `X:\…>` 在管線 stdin 形態有、`/dev/null` stdin 形態
  沒有，不能列入指紋。`cmd /c ver` 的正常輸出只有版本一行（無害形）。GBK 亂碼
  經 UTF-8 解碼成 U+FFFD，ASCII 前綴不變。（基於這個指紋的 advisory 面已移除：
  §8；未來任何機械修復要驗 cmd 形時仍需要這份量測。）
- **oc 安裝快照可能整批落後 master**：live 歸因前先比對 cache timestamp 與
  `git log`，否則把「跑舊版模組」誤判成「新版修復無效」（spec 有實錄）。
- **統計鍵**：移除的修復不新增鍵；`shell.cmdFlag`／`shell.envPath`／
  `shell.cmdBanner` 的歷史資料隨 install 檔保留（`adoptCounts` 照收）；新鍵按
  「surface × 故障機制」切；分母（`toolCalls`）口徑延續，否則與歷史資料斷鏈。
- **零頻率形不新增分支**（AGENTS 明文）；語料基線：508 條真實指令裡真要跑 cmd 的
  只有 2 條。
- **輸出截斷**：宿主截斷位置與機制不變（量測事實）；advisory 移除後此侷限不再
  約束插件（§8），記錄仍保留。

## 6. 殘留 live 驗證（計劃中、未啟動）

- 一輪乾淨 oc 對話走實際呼叫管道：`cmd //c ver`（預期：banner、exit 0——提示面
  已移除，advisory 不再出現、`shell.cmdBanner` 不再計數）；`A=/c/x node`（提示
  面移除後輸出側／指示層都無修——驗證值原樣抵達、外掛各行為零介入）；四個
  temp surface 一輪冒煙。
- 新電池＋packaging 全綠才算數；安裝後版本對照 cache snapshot（§5）。
- 工具面：`experimental_image_generate` 的 `path`（本機沒有 image model，無從實
  測）、`session_move.directory` 仍記臺帳不動。

## 7. 紅線

- **不動 pi 版**（`pi-extensions/`）；不動 cmdc 版
- 不為零頻率形加輸入側分支；不列舉工具（AGENTS 明文）
- **不重加任何依賴 AI 跟從的字串提示**（提示面已於 2026-11-07 移除；§8）
- 臨時腳本／探測產物放系統暫存目錄、用完清掉
- 驗證只用使用者指定的模型；換 provider（尤其付費）先取得同意

## 8. 2026-11-07：提示面移除（後續決策記錄）

redesign 當時把開放集合的校準落在兩個「文字提示」面上：`tool.execute.after`
的 cmd 互動 banner advisory（命中即在 `result.content` 附加 `[env-guard]`
文字）與 `ctx.session.hook("context"／"compaction"／"generate")` 的一行 envp
系統提示。**兩者於 2026-11-07 整體移除**，理由：

- **純靠 AI 判斷、跟從才生效的修復不在考慮範圍**：系統提示詞引導是機率性
  干預——模型可以不理會、可以漏看，效果有機率失效、無法機械驗證；附在終端
  輸出後的 advisory 同理。這類修復不是機制而是承諾，與「每項修復對應具體
  故障點、且有可機械驗證的機制」的審查清單相抵——一律移除，並禁止重加。
- **cmd banner 提示已由 bashrc `cmd()` 函式取代**（`docs/bash-vs-pwsh.md` §6.2
  `_cmdsw`：argv 層機械改寫，`cmd`／`cmd.exe` 兩側，按 `MSYS_NO_PATHCONV`
  存在與否定向，閉集合規則）：函式程式碼目前**尚未實際寫進本機 bashrc**；
  文件按「已取代」記錄——部署前 cmd banner 形是漏修臺。

同時移除的依附程式碼（只服務這兩個面）：`probeNoPathConv`／
`pathConvDisabled`／`pathConvCache`（`MSYS_NO_PATHCONV` presence probe）、
`spawnConvOff`（banner 措辭用）、三個 session hook、統計鍵 `shell.cmdBanner`；
對應電池段（banner 指紋、`execute.after` 契約、系統提示 marker、probe 語意）
同步刪除。電池現 110 條全綠。§5 的 BASH_ENV 陷阱與 §2 的宿主能力查證作為
量測事實仍然有效（未來任何機械修復仍需要它們）。
