# Archive — 封存模組與歷史修復層

本目錄存放已退役並封存的 Harness 插件、擴充模組與歷史測試。

---

## 封存內容

### 1. `opencode/env-guard` (OpenCode)
- **封存狀態**：OpenCode 轉向 PWSH 執行環境，原本針對 MSYS Bash 的路徑修正與 Temp 錨點（`path`, `glob`, `patchText`, `workdir`）不再需要。
- **技術精華**：記錄了 OpenCode 在 Node/Bun 執行層下路徑被 host API 密封時的閉集合修復範例，相關決策與數據保留在 [`docs/archive/oc-env-guard-redesign.md`](../docs/archive/oc-env-guard-redesign.md)。

### 2. `pi-agent/env-guard` (pi)

- **封存狀態**：pi 已改由現行的 `pi-agent/native-powershell` 提供原生 PWSH 執行，原有 Bash 下的 temp 路徑改寫與 cmd banner 偵測退役。
- **技術精華**：記錄了探測 `cygpath -w /tmp` 錨點、識別互動式 cmd.exe Banner 指紋以及跨 process PID 的持久化統計機制。
- **複測記錄（轉 PWSH 後）**：實測目前本地 pi 的 `resolveToCwd`，確認 temp 故障點仍在且非 bash 限定：`/tmp` 被解析成 `C:\tmp`；`$TEMP`/`$env:TEMP`/`%TEMP%` 不會被展開，而是原樣當成路徑的一部分，在專案根目錄底下建成以這些字串為名的資料夾（env-guard 原本的比對規則沒涵蓋 pwsh 常用的 `$env:TEMP` 寫法）。決定不復活這項修復：變數形式建出的資料夾就在專案內，掃 diff 就能發現，也不會破壞任何東西；`/tmp` 雖落在專案外的 `C:\tmp`，但 PWSH 語境下極少出現。至於 PWSH 下 `cmd //c` 的偽成功（banner + exit 0），屬模型語法錯誤而非環境轉換層破壞，依原生執行優先不介入；MSYS_NO_PATHCONV 探測天生依賴 bash，本環境不適用。

### 3. `opencode/pwsh-profile-shim` (OpenCode v2)
- **封存狀態**：被同目錄新增的 `pwsh-profile-loader` 取代。原方案以 C# shim exe 剔除注入的 `-NoProfile`（in-box `csc` 自動編譯部署至 `%LOCALAPPDATA%\opencode\pwshshim\`），每呼叫支付 ~17ms 的 CLR 啟動 + CreateProcess 雙行程稅。重新考古 v2.2.6 二進位確認 hook 觸發之後 spawner 才讀 `PH.command`（`trigger("shell","create.before",PH)` → `Pae(PH.shell, PH.command)`），改為純 hook 前置 `. $PROFILE`，零行程、零部署。
- **技術精華**：Windows argv 重引號規則的 C# 5 實作（零反斜線字面量、可內嵌 JS template literal）、in-box 編譯器條件探測、樹狀擊殺（`taskkill /T /F`）與直接子行程的語義推導。行為電池（11 checks）保留在 `archive/opencode/tests/shim/`。

**已刪除，不保留代碼**：`cmdc-mods` 全系列（env-guard、system-prompt、disable-tools）。原因：該系列當時仍是對一連串無法窮盡的轉換層問題逐一修補，即使改寫成 oc 或 pi 那種單點修復，要處理的問題面也更大，未來要修的話做法也會與現行架構差異很大，因此直接刪除。歷史規格書仍存於 [`docs/archive/spec-old.md`](../docs/archive/spec-old.md)。

---

## 測試與檢驗

封存程式碼與回歸測試依然維持完整可用狀態；封存測試不佔用現行 package.json 的 scripts，需要驗證歷史行為時在專案根目錄以 node 直跑：

```bash
node archive/pi-agent/tests/env-guard/index.mjs      # pi env-guard（48 項）
node archive/opencode/tests/env-guard/index.mjs         # oc env-guard（110 項）
```

另外，退役方案 pwsh-profile-shim 的行為電池（11 項）在 `archive/opencode/tests/shim/`，同樣以 node 直跑。

---

## 相關參考文件

- [`docs/bash-vs-pwsh.md`](../docs/bash-vs-pwsh.md) — 終端機評測、缺陷計分與放棄 Bash 轉向 PWSH 的完整論證。
- [`docs/archive/spec-old.md`](../docs/archive/spec-old.md) — 封存模組之完整歷史技術規格書（含故障分析與歷史實測邊界）。
- [`docs/spec.md`](../docs/spec.md) — 現行模組技術架構規格書。
- [`docs/archive/`](../docs/archive/) — 歷史設計與移植專案記錄。

