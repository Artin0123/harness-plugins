# harness-plugins

**Coding Agent Harness 插件與擴充合集**：秉持「環境修復」與「原生執行優先」理念見 [`AGENTS.md`](AGENTS.md)，針對不同 Harness (pi、OpenCode 等) 提供輕量、精準、可驗證的擴充功能。

## 核心架構：Windows 環境優先使用 PWSH

### 為什麼不用 Bash？
先前本專案曾針對各 Harness 維護複雜的 `env-guard`，試圖修復 Git Bash / MSYS 在 Windows 上的一連串環境轉換怪行為（如 `MSYS_NO_PATHCONV` 引起的路徑破壞、`/tmp` 錨點錯位、`cmd //c` 互動橫幅偽裝等）。

然而，根據本專案深入的評測與缺陷計分報告（詳見 [`docs/bash-vs-pwsh.md`](docs/bash-vs-pwsh.md)）：
- **PWSH 整體可靠度顯著優於 Bash（評分 −3.0 vs −9.0 ~ −9.5）**。
- **明確報錯 vs 靜默失敗**：PWSH 的陷阱多半在解析階段就拋出具體且可修正的 `ParserError`；而 Bash 在 Windows 下充滿了 `exit 0` 的假成功與嚴重的額外傷害（如 `> nul` 建立真實檔案、未引號反斜線路徑建立錯亂檔名、巢狀引號錯位等），這些屬於 Bash 原生剖析器行為，外掛層根本無法安全修復。
- **改不完的書寫變形**：在輸入進去之前逐字解析並改寫 Bash 指令，等於要窮舉所有可能的寫法（外面再包一層引號、heredoc、改用其他程式繞進來……變形無限增長），改錯一個字就是災難，維護下去只會越來越糟。

因此，所有針對 Bash 環境修復的 `env-guard` 模組以及停止維護的早期 Host 模組，已全數封存至 [`archive/`](archive/README.md)。

## 模組一覽

### native-powershell (pi-extensions)

- **解決的問題**：pi 自帶的 powershell 工具在 Windows 上固定加上參數 `-NoProfile -ExecutionPolicy Bypass`，命令前再塞一段設 UTF-8 的指令。後果有三：使用者自訂的 profile 不會載入；機器的執行原則（例如要求本機腳本須簽章的設定）被直接繞過；任何查看「這個程式是用什麼參數啟動」的地方都會看到那串多餘內容。
- **做法**：模組以同名工具取代內建版，命令文字原封不動交給 pwsh，參數只保留 `-NonInteractive`——少了它，遇到需要帳號密碼的步驟會跳出一個真的桌面視窗，把整個呼叫卡到逾時（實測帶旗標約 540 毫秒內完成拒絕，不帶則卡超過 8 秒才被強制收掉）。逾時或取消時，跟內建工具一樣把相關程式一次收乾淨。
- **代價**：無——不改命令內容、不加參數、不額外開程式，速度與內建工具同級。

### chat-trim-context (oc-plugins)

- **解決的問題**：OpenCode 在 `chat` 模式下，每次送給模型的請求都附帶一大段環境描述與 worktree 標記，白白佔用空間。
- **做法**：插件在請求送出前，把環境描述與標記清掉，其餘原封送出。
- **代價**：幾乎為零——每次請求前只是清幾段文字；模組本身約 12 KB、零依賴。

### pwsh-profile-loader (oc-plugins)

- **解決的問題**：OpenCode 執行命令時自己加上 `-NoProfile`（寫死在程式裡，沒有設定可以關），所以平常開 pwsh 終端會自動做的那些事——UTF-8 編碼、PATH 自動補上 git、python 虛擬環境自動啟用——在 OpenCode 的命令裡全都不會發生。
- **做法**：插件在命令送出前，把命令改成「先載我的 profile，再執行原命令」。已實測確認 OpenCode 實際執行的就是改寫後的命令；權限檢查在改寫之前就完成，不受影響。載入順序照 pwsh 原生：四個 profile 檔由大到小、逐個確認存在才載入；哪一個載入失敗，就用 pwsh 自家的錯誤格式印出來，不擋住要跑的命令；profile 全不存在時，那段載入碼什麼也不做。
- **代價**：每個命令多約 90 毫秒——這是執行使用者 profile 內容的時間（本機的 profile 做 git 掃描、虛擬環境啟用等，內容不同時間就不同），不是插件的固定開銷；原生終端開 pwsh 本來就付同一筆，OpenCode 命令是過去一直沒付。命令開頭多一段固定的載入碼；系統上不留其他任何東西——不編譯、不裝 exe、不佔系統目錄。

## 安裝指南

各 Host 提供「套件安裝（推薦）」或「手動複製」兩種方式：

### 1. pi (`native-powershell`)
需求：pi ≥ 0.48.0。

```bash
# 套件安裝（推薦）
pi install git:github.com/Artin0123/harness-plugins

# 手動安裝：複製到全域擴充目錄
cp -r pi-extensions/native-powershell ~/.pi/agent/extensions/
```

- 編碼前提：在實際解析出的 shell 之 $PROFILE 部署 `[console]::InputEncoding = [console]::OutputEncoding = UTF8`（pwsh 7 在 PATH 時為 `Documents\PowerShell\`；無 pwsh 時為 `Documents\WindowsPowerShell\`），否則非 ASCII 輸出為亂碼。
- 確認載入：`pi list`
- 移除：`pi remove git:github.com/Artin0123/harness-plugins`

### 2. OpenCode (`chat-trim-context`)

需求：OpenCode ≥ 2.2.5。

```bash
# 指令安裝（推薦）
opencode plugin add "github:Artin0123/harness-plugins#master::path:oc-plugins/chat-trim-context"

# 手動安裝：複製到全域或專案外掛目錄
cp -r oc-plugins/chat-trim-context ~/.config/opencode/plugins/
```

- 確認/更新：`opencode plugin list` / `opencode plugin update chat.trim-context`
- 移除：`opencode plugin remove chat.trim-context`

### 3. OpenCode (`pwsh-profile-loader`)

需求：OpenCode ≥ 2.2.5。

```bash
# 指令安裝（推薦）
opencode plugin add "github:Artin0123/harness-plugins#master::path:oc-plugins/pwsh-profile-loader"

# 手動安裝：複製整個目錄到全域外掛位置
cp -r oc-plugins/pwsh-profile-loader ~/.config/opencode/plugins/
```

- 確認/更新：`opencode plugin list` / `opencode plugin update pwsh.profile-loader`
- 移除：`opencode plugin remove pwsh.profile-loader`

## 測試與開發

測試的項目、涵蓋範圍與執行環境需求，全部記載在 [`docs/spec.md`](docs/spec.md) 的「測試」一節。執行：

```bash
npm run test:pi   # pi-extensions 測試
npm run test:oc   # oc-plugins 測試（packaging + pwsh-profile-loader）
```

---

## 相關文件

- [`AGENTS.md`](AGENTS.md) — 環境修復插件通用開發原則與審查清單。
- [`docs/bash-vs-pwsh.md`](docs/bash-vs-pwsh.md) — Windows 終端機評測、計分與轉向 PWSH 的論證依據。
- [`docs/spec.md`](docs/spec.md) — 現行模組技術規格書。
- [`docs/archive/spec-old.md`](docs/archive/spec-old.md) — 封存模組歷史技術規格書（含舊版 env-guard 問題分析與未修復問題記錄）。
- [`docs/archive/PLAN.md`](docs/archive/PLAN.md) — pwsh-profile-loader 決策與量測日誌（現行規格見 spec.md §3）。
- [`archive/README.md`](archive/README.md) — 封存庫說明文件。
