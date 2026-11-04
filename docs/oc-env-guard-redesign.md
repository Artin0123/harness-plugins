# oc env-guard redesign 交接說明

對象：接手 **oc 版**（`oc-plugins/env-guard`）redesign 的代理。pi 版已於
2026-11-04 完成同型 redesign（1303 → 420 行、48 項測試），本文件是過程中
**驗證過的事實、判準與陷阱**的濃縮。oc 的 host 層與 pi 不同，
每條結論都要在 oc 重新量測後才能採用（spec 開頭的原則：適用性在本 host 重新量過才留）。

## 0. 必讀順序

1. `AGENTS.md`（repo 判準：原生執行優先、寧可漏修不可誤修、修復審查清單）
2. `docs/spec.md` 的 oc 版各節＋「刻意不修與漏修的分界」＋「只能靠寫對的形」
3. 本文件
4. `pi-extensions/env-guard/index.ts` 與 `pi-extensions/tests/env-guard/index.mjs`
   （參考實作，420 行；oc 版現況約 1300 行，為同一顆 lexer 的移植）
5. 使用者的環境文件：
   https://github.com/Artin0123/windows-setup/blob/main/docs/msys-no-pathconv.md
   ——其機制主張（argv 轉換表、`//c` 病理、`MSYS2_ARG_CONV_EXCL` 語意）已全部實測驗證為真

## 1. 已定案、不要重新訴訟的結論

| 結論                                                                                                                                                                                                   | 證據出處                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MSYS_NO_PATHCONV=1`（bashrc）**保留**。轉換開啟會把模型最自然的拼法靜默弄壞（`cmd /c` → `C:/` → 互動 banner、exit 0 假成功）；關閉的失敗誠實、可自癒。排序：**關閉＋guard ＞ 開啟＋小修 ＞ 開啟不修** | spec pi 機制節＋使用者文件（含實測：`/a/b` 形資料無自然拼法）                                                                                                              |
| 輸入側 bash lexer 是 review 不收斂的**結構性**根源                                                                                                                                                     | git log：6 天 5 個 misfix commit（cdf4d45、c062b4f、9010e01、668a1cb、…）；實際命中：cmdFlag 32 次／1912 次 bash 呼叫、envPath 7 次——維護面 600 行狀態機 vs 五天 39 次命中 |
| 三層故障面厚度：pi↔git bash **薄**（修得完）；git bash↔native exe **厚**（開放集合，靜態不可修，治本在提示與自癒）；git bash↔WSL ≈ **零**                                                              | 兩態實測（spec 各節）                                                                                                                                                      |
| 靜默失敗才值得機器修；大聲失敗讓它壞（模型看得到真原因、一輪自癒）                                                                                                                                     | AGENTS.md「分界」＋活體案例（MODULE_NOT_FOUND 一輪自癒結案）                                                                                                               |

## 2. 收斂機制（核心設計原則）

1. **輸入側改寫僅限閉集合**：欄位語意單一（`path` 欄位永遠是路徑）、形態可數
   （temp 族三種語法 × 有限變數名）。開放集合（bash 語法、任意變數、外部程式的
   參數結構）**禁止**進入輸入側——那是無窮 review 的入口。
2. **靜默失敗 → 輸出側偵測＋advisory**：誤判代價＝多一段文字、零執行破壞；
   漏判＝保守放行。這是唯一零誤修成本的修復位置。
3. **開放集合的「寫對形」→ 系統提示**：一條規則覆蓋全部變體（提示是閉集合）。
   例：前綴賦值寫 `VAR=C:/x`、native exe 旗標單斜線、路徑給原生 exe 用 Windows 形。
4. **新增修復的三道門**：(a) 指名故障點＋兩態實測重現；(b) 確認閉集合；
   (c) 誤判代價有上界。
5. **舉證責任在提案方**：新 edge case 主張必須附 stats 命中或 live 重現，
   否則不動。這是 review 能終結的機制——不是靠自律，是把舉證負擔倒轉。

## 3. oc 的分岔點——先查證、再設計

oc 的 surface 比 pi 廣（`path`／`glob`／`patch`／`workdir` vs pi 只有 `path`）：

- **temp 前綴改寫（四個 surface）**：閉集合輸入側，redesign 後可保留——但每個
  surface 要重驗落點（spec oc 實測記錄節有現成方法與判準）。
- **關鍵未知 ①：oc 有沒有輸出側 hook？** pi 的 `tool_result` 可修改工具輸出
  （middleware 鏈、partial patch）。oc 目前用的都是 before hook
  （`execute.before`／`create.before`）。**先查 oc SDK 的 hook 清單**——若無
  輸出側事件，cmd banner backstop 在 oc 做不了，替代方案：(a) 窄快路徑
  cmdFlag 改寫（僅 `^cmd //c` 行首等極窄形），或 (b) 只靠系統提示。這是
  redesign 的第一個決策點，查證前不要動手。
- **關鍵未知 ②：oc 能否注入系統提示？**（pi 用 `before_agent_start` 的
  `promptGuidelines`，快取友善）。查 oc 的 instructions／template override 能力。
- **oc host 自帶「Portable shell scanner」預檢**（會擋部分 heredoc 形、
  回傳≠原生）：spec oc 接線段有記錄。確認 redesign 後哪些形還會被 host 層攔
  ——host 層的病不是插件能修的，記臺帳。
- **transport 折疊**（指令字串成對 `\\` 折一層，git-bash 專有；oc 與 pi 同，
  live 實測 2→1、4→2）：對輸出側偵測**無影響**；若保留任何輸入側改寫，掃描器
  必須建模折疊（spec 有完整實測表與 `foldedRun` 模型記錄）。

## 4. 陷阱清單（pi 過程實踩、oc 重測時會再遇到）

- **BASH_ENV 探針陷阱**：bashrc 的 `MSYS_NO_PATHCONV` 經 `BASH_ENV` 對所有
  子 bash 生效。單 `env -u MSYS_NO_PATHCONV` 是**假讀數**（子 bash 又從 bashrc
  補上）；量 native 行為要 `env -u BASH_ENV -u MSYS_NO_PATHCONV`。
- **探測對象 ≡ spawn 對象**：用 host 同一個 shell 決策路徑探測，不要自製
  PATH 搜尋（解析順序與 host 不同會選到別顆 bash，結論漂移）。
- **banner 指紋用實抓位元組，不要拼樣本**：指紋＝輸出前兩個非空行
  （`Microsoft Windows [` ＋ `(c) Microsoft`）——ASCII 前綴跨語系／跨 code page
  存活。提示符行 `X:\…>` 在管線 stdin 形態有、`/dev/null` stdin 形態**沒有**，
  不能列入指紋。`cmd /c ver` 的正常輸出只有版本一行（無害形，勿誤報）。
  GBK 亂碼經 UTF-8 解碼成 U+FFFD，ASCII 前綴不變。
- **oc 安裝快照可能整批落後 master**：live 歸因前先比對 cache timestamp
  與 `git log`，否則把「跑舊版模組」誤判成「新版修復無效」（spec 有實錄）。
- **統計鍵**：移除的修復其歷史鍵保留不動（`adoptCounts` 吸收）；新鍵按
  「surface × 故障機制」切；分母（`toolCalls`）口徑延續，否則與歷史資料斷鏈。
- **零頻率形不新增分支**：508 條真實指令語料裡真要執行 cmd 的只有 2 條。
- **行為修改必配回歸測試**：放 `oc-plugins/tests/`；gate 兩方向（轉換開／關
  的機器）都要能跑同一份電池。
- **輸出截斷**：pi 的 bash 輸出截尾（最後 N 行／N KB）會截掉 banner 首行
  ——偵測不到就放行，保守方向，不要為此加輸入側邏輯。

## 5. 建議順序

1. 查證 §3 的兩個關鍵未知（hook／系統提示能力）——這決定設計形態
2. 更新 `docs/spec.md` oc 段（先寫設計、再動碼）
3. 實作＋測試電池（照 §2 三道門自審每一項）
4. live 驗證：走 oc 實際呼叫管道做修前／修後對照；stats 與 pi 量測對照
5. 清理 spec 中 oc 的舊掃描器臺帳（pi 的清理方式可參考：稽核段刪除＋
   歷史指針註記＋git 備份；oc 段落中引用「pi 第二輪」等交叉參照的歷史內容
   在 commit e5b415f 及其前的版本）

## 6. 紅線

- **不動 pi 版**（`pi-extensions/`）；不動 cmdc 版
- 不為零頻率形加分支；不列舉工具（AGENTS 明文）
- 臨時腳本／探測產物放系統暫存目錄、用完清掉
- advisory／系統提示**純 ASCII**（非 ASCII 一旦被錯誤轉碼不可逆）
- 驗證只用使用者指定的模型；換 provider（尤其付費）先取得同意
