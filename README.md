# harness-setup

Coding Agent 的環境修復設置合集。Windows 上以原生 PowerShell 為目標，不使用 Git Bash。

每一個設置只做一件事：讓 Agent 寫出的語法在目標環境裡本來就正確時，不被 Harness 自己的預設參數或轉換層破壞。安裝、代價與使用方式寫在本文件；決策理由、實測數據與已知差異寫在 [`docs/spec.md`](docs/spec.md)；通用開發原則寫在 [`AGENTS.md`](AGENTS.md)。

## 設置一覽

### native-powershell（pi 擴充）

- **解決的問題**：pi 內建的 `powershell` 工具固定用 `-NoProfile -ExecutionPolicy Bypass` 啟動 PowerShell，所以你的 `$PROFILE` 從來沒被載入，機器的腳本執行原則也被繞過。裝了這個擴充之後，兩件事回到一般終端機的樣子：profile 會載入，執行原則照機器設定。除了這兩個旗標，其餘行為與內建工具相同，包含命令前面那段 UTF-8 設定、逾時與取消的判定、離開碼、錯誤訊息與輸出內容。
- **代價**：每次呼叫多出載入你的 `$PROFILE` 的時間。這段時間完全由你自己的 profile 決定，與擴充無關：空 profile 幾乎不花時間，裝了 oh-my-posh 或大量模組的 profile 可能多出好幾百毫秒。本機的 profile 實測讓每次呼叫從 341 毫秒變成 443 毫秒（各三次的中位數，差 102 毫秒），別的機器不會是同一個數字。profile 印出的內容與錯誤訊息也會出現在工具輸出裡。
- **限制**：pi 本體被強制終止時（不是逾時、也不是取消），擴充啟動的行程樹不會被 pi 清理。pi 內建工具原本會登記子行程 pid 供本體清理，登記簿不對擴充開放。另外，擴充將內建版的三個常數與一段命令前綴複製了一份，pi 升級後這些複本不會自動更新；升級 pi 之後跑 `npm run test:pi`，測試會拿已安裝的 pi 逐項比對並回報差異。
- **需求**：Windows 上的 PowerShell 7 或 Windows PowerShell 5.1、pi ≥ 0.84.3，而且 `powershell` 工具必須在啟用清單裡。

### chat-trim-context（OpenCode 插件）

- **解決的問題**：OpenCode 在 `chat` 模式下，每次送給模型的請求都附帶一段環境描述，佔用空間卻對任務沒有幫助。裝了之後那段被移除，系統提示的其餘內容逐字不變。
- **代價**：無。每次請求只做字串比對與移除，插件本身沒有依賴。
- **需求**：OpenCode ≥ 2.2.5。

### pwsh-profile-loader（OpenCode 插件）

- **解決的問題**：OpenCode 執行 shell 命令時固定加上 `-NoProfile`，所以平常開啟 pwsh 終端會自動完成的事（UTF-8 編碼、PATH 補上 git、python 虛擬環境自動啟用）在 OpenCode 的命令裡不會發生。裝了之後這些設定會生效，命令本身逐字不變。
- **代價**：每道命令開頭多一段 794 字元的載入程式碼，加上執行 profile 的時間（由你的 profile 內容決定）。profile 印出的內容會出現在工具輸出裡。
- **需求**：OpenCode ≥ 2.2.5。

## 安裝

每個 Harness 都提供「套件安裝」與「手動複製」兩種方式。

### 1. pi：native-powershell

本擴充用到 `createPowerShellTool`、`getPowerShellConfig` 與 `PowerShellOperations`，這三個介面最早在 pi 0.84.3 一起出現；npm 上最舊的可用版本 0.74.0 完全沒有 powershell 相關匯出。

```bash
# 套件安裝（推薦）
pi install git:github.com/Artin0123/harness-setup

# 手動安裝：複製到全域擴充目錄
cp -r pi-agent/native-powershell ~/.pi/agent/extensions/
```

安裝後確認三件事：

- `powershell` 工具在啟用清單裡（`defaultTools` 或 `--tools` 參數）。擴充是取代同名工具，工具沒有啟用就不會被呼叫，效果等同沒有安裝。
- `pi list` 看得到這個擴充。
- 不需要另外設定編碼。擴充沿用內建工具那段 UTF-8 設定指令，非 ASCII 輸出在安裝完就能正常顯示。

移除：`pi remove git:github.com/Artin0123/harness-setup`。

### 2. OpenCode：chat-trim-context

```bash
# 指令安裝（推薦）
opencode plugin add "github:Artin0123/harness-setup#master::path:opencode/chat-trim-context"

# 手動安裝：複製到全域或專案外掛目錄
cp -r opencode/chat-trim-context ~/.config/opencode/plugins/
```

確認與更新：`opencode plugin list`、`opencode plugin update chat.trim-context`。移除：`opencode plugin remove chat.trim-context`。

### 3. OpenCode：pwsh-profile-loader

```bash
# 指令安裝（推薦）
opencode plugin add "github:Artin0123/harness-setup#master::path:opencode/pwsh-profile-loader"

# 手動安裝：複製整個目錄到全域外掛位置
cp -r opencode/pwsh-profile-loader ~/.config/opencode/plugins/
```

確認與更新：`opencode plugin list`、`opencode plugin update pwsh.profile-loader`。移除：`opencode plugin remove pwsh.profile-loader`。

## 測試

```bash
npm run test:pi   # pi 擴充的測試
npm run test:oc   # OpenCode 插件的測試（packaging + pwsh-profile-loader + chat-trim-context）
```

測試項目、涵蓋範圍與執行環境需求（Node.js 22.6 以上）記在 [`docs/spec.md`](docs/spec.md) 的「測試」一節。

## 相關文件

- [`AGENTS.md`](AGENTS.md)：環境修復設置的通用開發原則與修復審查清單。
- [`docs/spec.md`](docs/spec.md)：三個設置的決策、條件、實測數據與已知差異。
- [`docs/bash-vs-pwsh.md`](docs/bash-vs-pwsh.md)：Windows 終端機評測與計分，PowerShell 與 Bash 取捨的依據。
- [`archive/README.md`](archive/README.md)：封存設置的說明。
- [`docs/archive/spec-old.md`](docs/archive/spec-old.md)、[`docs/archive/PLAN.md`](docs/archive/PLAN.md)：封存設置的歷史技術規格與量測日誌。
