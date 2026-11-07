# 計畫：③′ plugin + 靜態 shim — 讓 opencode shell 載入 PowerShell profile

> 狀態：計畫書（未執行）。依據：2026-11-06 labs 實測（lab-plugin-shim 三項全綠，~615ms，詳見對話紀錄）。

## 0. 目標與非目標

**目標**
- opencode 的 shell 工具（pwsh/powershell）spawn 時載入使用者 PowerShell profile。
- 掃描器（permission 資源提取、語法判定）維持 PowerShell 模式。
- 其他程式呼叫 `pwsh` 完全不受影響（shim 不進 PATH、不設環境變數、不是全域覆蓋）。
- opencode 升級後不需重做任何事（不綁 build offset）。

**非目標**
- 不處理 bash/其他 shell 的等效問題。
- 不改 opencode 原始碼/上游 PR（可另提 issue，見 §7）。

## 1. 原理鎖鏈（已驗證）

1. `packages/core/src/shell.ts`：`hooks.trigger("shell","create.before",invocation)` 在 `ShellSelect.args(invocation.shell, invocation.command)` **之前**執行 → plugin 可改 `invocation.shell` / `invocation.command`。
2. `ShellSelect.args()` 以 basename（不帶副檔名、小寫）查 META：`pwsh|powershell` → 注入 `-NoLogo -NoProfile -NonInteractive -Command`。
3. `ShellParse.scan()` 以同一 basename 決定 PowerShell 掃描器 → 檔名叫 `pwsh.exe` 就保住 PS 模式。
4. shim（編譯自 C#，5KB）收參數 → 剔除 `-NoProfile`（case-insensitive、僅整個 token 相等時）→ 以標準 argv 重引號規則轉發真 pwsh → exit code 透傳。

所以：plugin 把 `event.shell` 從真 pwsh 改指向同名 shim（**路徑不重要，檔名必須是 `pwsh.exe`**），上面 1→4 全部成立，spawn 只多一層 ~1ms 轉發 + profile 載入（實測 +115ms 左右）。

## 2. 成品(檔案)清單

```text
%LOCALAPPDATA%\opencode\
└─ pwshshim\
   ├─ pwsh.exe                 ← csc 編譯產物（唯一系統足跡，被動檔案，不在 PATH）
   ├─ shim-src.cs              ← 來源碼存檔
   └─ setup.ps1                ← 安裝器（編譯 + 寫 plugin 檔 + 驗證）
<plugin 位置，擇一>                ← §3 之 D 項定案
└─ pwsh-profile-shim.ts          ← plugin，內含 shim 絕對路徑（setup.ps1 生成/更新）
```

## 3. 各檔案細節

### A. `shim-src.cs`（變體 A：靜態路徑；變體 B：環境變數路徑，建議做 B）

- B 讀環境變數 `OCPWSH_PATH`；plugin 在 `create.before` hook 同時設定 `event.env.OCPWSH_PATH = <真 pwsh 絕對路徑>`（`ShellCreateBefore.env` 是 spawn 的 env，會傳給 shim）。
- 回退：B 讀不到 env 時用硬編碼 `C:\Users\<user>\scoop\apps\pwsh\current\pwsh.exe`（`current` junction 隨 scoop 升級自動跟新）。
- 行為：跳過等值 `-NoProfile` token（OrdinalIgnoreCase）；其餘參數原樣保留、順序不變；標準 Windows argv 重引號（反斜線/引號成對規則）；`UseShellExecute=false`、WaitForExit、return p.ExitCode。
- 邊界：`-NoProFile` 之類大小寫混合剔除；不處理 `--%`（opencode 不會送）；參數內含 `"`/空白已實測 OK（`Write-Output "a b c"` 全綠）。

### B. `pwsh-profile-shim.ts`（plugin，路徑在 setup 時寫死）

```ts
import { Plugin } from "@opencode/plugin"
const SHIM = "<%LOCALAPPDATA% 路徑，setup.ps1 生成>"
export default Plugin.define({
  id: "pwsh-profile-shim",
  setup: async (ctx) => {
    await ctx.shell.hook("create.before", (event) => {
      const lower = event.shell.toLowerCase()
      if (lower.endsWith("\\pwsh.exe") || lower.endsWith("\\powershell.exe")) {
        event.env.OCPWSH_PATH = event.shell      // 變體 B：把找到的真 pwsh 傳給 shim
        event.shell = SHIM
      }
    })
  },
})
```
- 已知可行（lab-plugin-shim 即此形，只是 shim 讀硬編碼路徑）。
- 細部：plugin 名衝突→id 固定、setup 冪等；`event.env` 傳遞 `OCPWSH_PATH` 行為需在 A 變體下重測一次（單元測 shim 直接跑：`$env:OCPWSH_PATH=...; shim.exe …`）。

### C. `setup.ps1`
1. 找真 pwsh：`(Get-Command pwsh).Source`（找不到 powershell.exe 也可，META 兩者皆 ps）。
2. `csc.exe /nologo /target:exe /out:...\pwsh.exe shim-src.cs`（csc 位於 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\`，已確認存在；無 csc 時走 §5 fallback）。
3. 生成/更新 `pwsh-profile-shim.ts`（把 SHIM 路徑字串寫入）。
4. 自檢：直接跑 `shim -NoLogo -NoProfile -NonInteractive -Command "1+1"` 應輸出 `2`。

### D. plugin 放哪（需要一小段驗證的待決項）
- **專案層**：`<project>\.opencode\plugin\pwsh-profile-shim.ts` — 實測確定可載（v2.2.5 `source-directory.ts` 掃 `.opencode/plugin|plugins` 下的 .ts/.js/目錄），但要每個專案掛。
- **全域**：需實測 `~/.config/opencode/plugin/` 是否同樣被 discover（README/原始碼跡象支持但未實測）；若不行，用 config `"plugins": [\"<絕對路徑 目錄>"]`（config plugin source 支援目錄/單檔，路徑解析規則要驗證）。
- 定案順序：全域目錄 → config plugins 絕對路徑 → 每專案。

## 4. 測試計畫（含既有 lab 資產）

| #   | 測試             | 方法                                                                      | 通過條件                                |
| --- | ---------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| T1  | shim 單元        | 直呼 shim 各參數組合                                                      | 轉發正確、exit code 透傳、剔 -NoProfile |
| T2  | marker E2E       | lab mock server + `opencode run --auto --standalone`，profile 暫插 marker | `PROFILE-LOADED`                        |
| T3  | 掃描器           | `$v = $PSVersionTable…`                                                   | `psver=…`（不觸發 cannot analyze）      |
| T4  | 引號             | `Write-Output \"a b c\"`                                                  | 原樣輸出                                |
| T5  | 權限視圖         | 觀察 shell 工具描述 trace                                                 | 仍是 "using pwsh"                       |
| T6  | 其他程式不受影響 | 非-opencode 環境直呼 `pwsh -NoProfile -c …` 直呼真 pwsh                   | 行為/速度與 shim 無關                   |
| T7  | 升級魯棒         | 模擬：plugin 不動、opencode 原版 exe                                      | T2~T5 仍過                              |

lab 資產可複用：`lab/mockserver.mjs`、`lab/lab-plugin-shim/*`（已是 ③′ 原型）、`lab/sample-lab.ps1` 改成收 shim/plugin 路徑參數即可。

## 5. 風險與 fallback
- **無 csc**（罕見）：改用 .NET SDK `dotnet build` 或退回 route ②（純插件巢狀，全綠、836ms，已在 lab 驗證）；或 route ④（binary patch 腳本 `lab/patch-exe2.mjs` 已寫好）。
- **pwsh 搬家**：B 變體由 plugin 每次傳真實路徑，shim 僅剩 fallback 常數需人工改。
- **opencode 更新改 hook 契約**：`shell.create.before` 是公開 plugin 介面，改壞機率低；若改了，fallback ②/④。
- **profile 很肥**（~330ms 直測差）：+115ms 實測 tool 端，可接受；之後嫌慢可縮 profile。
- **權限資源顯示**：掃描器看到的是 shim 路徑的 basename `pwsh`，PS 模式保留，但語意上資源解析以 shim 為準？(T5 一併觀察 permission prompt 文本)。

## 6. 安裝/移除
- 安裝：`setup.ps1`（幂等，可重跑）。
- 移除：刪 plugin 檔 + `%LOCALAPPDATA%\opencode\pwshshim\` 整個目錄即可；無任何系統狀態殘留。

## 7. 順手事項（非本計畫必要）
- 對上游開 issue：`ShellSelect.args()` 增加「不注入 -NoProfile」選項（一行改動）；本計畫足跡都是隨用戶的 workaround。

## 8. 驗收標準
- T1–T6 全綠；T7 在升級模擬後仍全綠。
- `Get-Process pwsh | ...` 顯示 opencode 的 shell spawn 已無 `-NoProfile`（profile 由 shim 轉發的真 pwsh 載入）。

