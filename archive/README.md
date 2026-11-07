# Archive — 封存模組與歷史修復層

本目錄存放已退役並封存的 Harness 插件、擴充模組與歷史測試。

---

## 封存內容

### 1. `cmdc-mods/` (Command Code)
- **封存狀態**：Host（Command Code 1.88.x）停止維護，對自訂模型的支援度不如現行 harness；且其執行層深度依賴 Windows cmd/bash 混成路由。
- **組件**：
  - `env-guard`: 判定指令型態，將 Unix 指令轉導至 Git Bash、Windows 原生指令以 `powershell -EncodedCommand` 封裝以確保 UTF-8 輸出。
  - `system-prompt`: 透過專案或全域的 `SYSTEM.md` / `APPEND_SYSTEM.md` 無痛置換或附加提示詞。
  - `disable-tools`: 在 Model Schema 發出前過濾特定工具。

### 2. `oc-plugins/env-guard` (OpenCode)
- **封存狀態**：OpenCode 轉向 PWSH 執行環境，原本針對 MSYS Bash 的路徑修正與 Temp 錨點（`path`, `glob`, `patchText`, `workdir`）不再需要。
- **技術精華**：記錄了 OpenCode 在 Node/Bun 執行層下路徑被 host API 密封時的閉集合修復範例，相關決策與數據保留在 [`docs/archive/oc-env-guard-redesign.md`](../docs/archive/oc-env-guard-redesign.md)。

### 3. `pi-extensions/env-guard` (pi)
- **封存狀態**：pi 已改由現行的 `pi-extensions/native-powershell` 提供原生 PWSH 執行，原有 Bash 下的 temp 路徑改寫與 cmd banner 偵測退役。
- **技術精華**：記錄了探測 `cygpath -w /tmp` 錨點、識別互動式 cmd.exe Banner 指紋以及跨 process PID 的持久化統計機制。

---

## 測試與檢驗

封存程式碼與回歸測試依然維持完整可用狀態，若需驗證歷史行為，可於專案根目錄執行：

```bash
npm run test:archive
```

該指令會依序執行：
1. `archive/cmdc-mods` 的 env-guard、system-prompt、disable-tools 測試（全數綠燈）。
2. `archive/pi-extensions/env-guard` 單元測試套件。
3. `archive/oc-plugins/env-guard` 單元測試套件。

---

## 相關參考文件

- [`docs/bash-vs-pwsh.md`](../docs/bash-vs-pwsh.md) — 終端機評測、缺陷計分與放棄 Bash 轉向 PWSH 的完整論證。
- [`docs/archive/spec-old.md`](../docs/archive/spec-old.md) — 封存模組之完整歷史技術規格書（含病理分析與歷史實測邊界）。
- [`docs/spec.md`](../docs/spec.md) — 現行模組技術架構規格書。
- [`docs/archive/`](../docs/archive/) — 歷史設計與移植專案記錄。

