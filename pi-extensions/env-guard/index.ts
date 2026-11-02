// env-guard.ts
// 防護 pi 在 Windows 上的路徑與 shell 事故。優先序（最高到最低）：
//
// 1.【原生執行最優先】原生就會壞的，讓它壞——不論失敗是大聲還是靜默。
//    「靜默失敗要修」只在修的對象是『本環境的工具轉換/處理自己弄壞』時才成立；
//    模型寫錯或 bash/Node 原生行為造成的任何失敗（含靜默），一律不介入。
// 2.【環境工具失敗才修】只修這一類：模型寫的語法在它假設的環境裡是正確的，
//    但被本環境的工具轉換或處理弄壞：
//   - /tmp、$TEMP：對 bash 是正確語法，但 write/edit/read/grep/find/ls 工具
//     在 host 端解析，不經 MSYS 映射、不展開變數 → 寫入建成 C:\tmp 或
//     字面 "$TEMP" 資料夾，搜尋類直接報錯（~ 工具自身會正確展開，不需管）。
//     變數形式全擋：$TEMP/$TMP/$TMPDIR、%TEMP%/%TMP%，不分大小寫與分隔符。
//     故障點只在 Windows 的 tool 解析層，所以整段改寫只在 win32 生效；且必須
//     先問到 bash 的 /tmp 錨點（cygpath -w /tmp），問不到就不改寫（不猜佈局）。
//   - cmd //c|//k：原生 git-bash（預設開啟路徑轉換）下 //c 是唯一能用的寫法，
//     但本機 ~/.bashrc 設了 MSYS_NO_PATHCONV（MSYS 只看變數「存在」，實測值
//     0／空字串／false 也一樣停用轉換），//c 原樣抵達 cmd → 進互動模式
//     （印橫幅、指令沒跑、exit 0）。bashrc 對擴充不可見，故以子 bash 探測
//     （見下方 pathConvDisabled），確認轉換關閉才啟用改寫——探測失敗一律不改寫。
//     適用 cmd 與 cmd.exe、指令位置（含 if/while/{/!/time 等 POSIX 語法關鍵字、
//     env/exec/command/builtin 等後接指令字的內建之後）的全部 //字母旗標
//     （含多旗標 cmd //q //c）。
//   - bash 前綴賦值的 POSIX 路徑值（VAR=/c/…、VAR=/tmp/… 後接指令字）：實測
//     原生 git-bash 在 spawn 原生程式時對 envp 做「值語法」轉換（name-agnostic：
//     變數名不參與判斷，FOO 與 XDG_CACHE_HOME 一視同仁；/c/foo→C:/foo、
//     /tmp→實際掛載點，輸出正斜線），本機 MSYS_NO_PATHCONV 一樣停用這層 →
//     值原樣抵達 node，path.join 不做盤符映射、前導 / 被當成磁碟相對路徑解析
//     → 寫到 C:\c\foo（靜默錯位，exit 0）。修法＝逐條重現該層的不變式規則
//     （不猜哪個變數是路徑——轉換層自己就不看名字）：只修「前綴賦值＋後接
//     指令字」的靜態未引號整值（實測 A=1 (…)、A=1 foo() {…}、A=1 if… 全是
//     syntax error，賦值前綴只存在於 simple command——standalone 賦值是 shell
//     變數，bash 端語意本來就需要 POSIX 值，改它才是誤修）。盤符形 /c、/c/…
//     →C:/…（不分大小寫、輸出大寫）；/tmp、/tmp/…→cygpath 錨點（正斜線風格
//     與原生 envp 輸出一致；問不到錨點就不修）。緊貼的動態尾部（VAR=/c/x$(…)）
//     以組合律處理：轉換是「前綴改寫、後綴逐字保留」，前綴改寫＋動態後綴＝
//     對串接後完整值的原生轉換。
//
// 分類判準：「刻意不修」＝原生失敗——工具的回傳與原生相同，agent 看到的是
// 真實原因、可自癒；環境轉換層造成的失敗（工具回傳≠原生）不論大聲或靜默都
// 是漏修——大聲只是失敗的形態、不是不修的豁免；漏修留在臺帳，僅因每個靜態
// 修法都需要開放集合的猜測（以誤修風險為界）。
//
// 【刻意不修＝原生失敗（工具回傳≡原生）】讓它壞：
//   - C:\tmp：write 工具寫 C:\tmp 原生會成功（合法 Windows 路徑）——原生不壞就不修，
//     模型真寫 C:\tmp 就讓它寫。
//   - nul 重導向（> nul、2>nul、&>nul…）：重測（轉換開／關皆驗）本機 bash 在
//     cwd 建出實體 nul 檔（Windows dir 可見、內容為重導向輸出）——舊註解「裸
//     nul 映射到丟棄裝置、多數形態不建檔」與現況不符，已按重測修正。不修的
//     判準不變：bash 原生行為（原生 git-bash 同樣建檔、無 pi 介入、無環境層
//     故障點——bash 的丟棄裝置是 /dev/null，寫 >nul 是模型 cmd-ism 的自身錯誤
//     ）；殘留檔 `rm nul` 即可刪。write 工具 path="nul" 同理（Node host 端
//     原生就會建真檔——實測 dir 可見，非 pi 加工）。
//   - < nul：bash 直接報 ENOENT，錯誤訊息自己會說話
//   - 2>&nul、<&nul：ambiguous redirect，大聲失敗且不造檔
//   - 重導向目標的雙斜線（`cmd //c "x" > //out`）：目標路徑是 bash 自己開檔時
//     解析的，根本不經被 MSYS_NO_PATHCONV 關掉的 argv 轉換層——沒有故障點；
//     原生就是大聲失敗（`//out: Is a directory`），改寫它反而會靜默寫到
//     別的位置（`> /tmp/eg.log` 真的建檔），所以目標原樣不動。
//   - 原生就壞的雙斜線形（cmd //?、cmd ///c、cmd //server/share）：實測轉換
//     開啟時一樣進互動模式 → 模型自己寫錯，不修。
//   - 其他 cmd-ism（del、dir /b、robocopy //mir…）：bash 沒有這些指令——
//     "command not found" 是 bash 自己的訊息（回傳≡原生），大聲失敗、agent 自矯正。
//
// 【漏修臺帳】環境轉換層造成（工具回傳≠原生），大聲≠豁免；留下的唯一理由＝
// 靜態修法需要開放集合的猜測、誤修風險大於漏修：
//   - 外部 wrapper 指令後的 cmd（timeout 5 cmd //c …、xargs …、nice …）：
//     原生（轉換開啟）可跑、本機被同一層弄壞（實測 timeout 2 cmd //c ver
//     原生跑出 ver、本機只印 banner）。要在指令位置判定裡跳過 wrapper 的
//     參數，就得知道每個 wrapper 的參數結構——開放集合＋猜測，違反「只留
//     不變的部分」。env/exec/command/builtin 不在此列：env 是 POSIX 標準
//     程式、其餘是 bash 內建，「後接第一個非選項詞＝被執行的指令」是閉集合
//     語法（已納入 RESERVED_WORD；實測 env/exec/command cmd //c ver 原生跑
//     ver、本機 banner——同一故障，與 oc 版 SHELL_KEYWORDS 對齊）。
//   - / 前綴原生工具的雙斜線旗標（taskkill //IM、sc //query、robocopy //mir、
//     findstr //n…）：與 cmd //c 同一個故障點（原生靠 // 形成功、本機轉換關閉
//     原樣抵達而失敗——實測 taskkill exit 1 大聲報『無效參數 //IM』；反向在
//     原生環境把 /IM 轉成 C:/…/Git/IM 也失敗）；失敗是大聲的（事件實錄：拿掉
//     遮罩後下一步就改 /IM），靜態修復又需列舉「哪些程式吃 / 旗標」（開放集合
//     ＋猜測）→ 留在漏修臺。cmd 是唯一例外：失敗靜默（互動模式、exit 0）且是
//     OS shell，已修（判準見掃描器註解）。
//   - 原生程式的 POSIX 路徑參數（`git -F /tmp/x`、`git hash-object /tmp/x`、
//     `python /tmp/x.py`…）：預設 git-bash 靠 argv 轉換才成立，本機轉換關閉就
//     變成 `could not open '/tmp/…'`（實測；MSYS 程式如 cat/ls 不受影響）。
//     判斷「哪個參數是路徑」需要各程式自己的參數語義（開放集合＋猜測），把
//     所有 /… 參數硬改成 Windows 路徑又會改壞字串／regex（`echo /tmp`、
//     `grep /tmp`、`sed 's|/tmp|X|'`）。
//   - 絕對路徑 cmd（C:\…\cmd.exe //c）、引號形式（"cmd" //c）、跳脫（\cmd //c）：
//     同一故障層，但模型實務不會這樣寫（有機出現 0），加了只是多一個作用點。
//   - case 樣式的 `)`（`case $x in a) cmd //c ver;; esac`、以及它包在 `$( )` 裡的
//     形）：bash 語法上這個 `)` 沒有對應的 `(`，要修得追蹤 case/in/esac 狀態，
//     而 case body 裡合法的 `$( )` 一旦誤判（該 pop 變成不 pop）就會把資料改壞
//     ——實測目前只落在漏修側（資料不會被改寫），故維持不追蹤（已釘樁）。
//
// 【漏修臺帳（envp 層）】原生 envp 轉換會轉、掃描器無法靜態安全重現的值形：
//   - 前綴賦值值的其他形態：根相對路徑（VAR=/usr、/foo…——原生映射到 MSYS
//     安裝根，非不變式，fstab/nsswitch 可自訂）；引號開頭的值（VAR="/c/foo"
//     ——引號切開 token，掃描器見不到整值）；清單值（VAR=/c/a:/c/b——原生
//     清單轉換是另一套規則，輸出 C:\a;C:\b）；含 \ 的值（cmd-ism 分隔符）；
//     wrapper 的賦值參數（env X=/c/…、export X=/c/…——argv 位置，同 wrapper
//     cmd 的開放集合）；重導向交錯形（A=/c/x > log node——重導向後掃描器
//     已當參數區）：一律照原樣。
//
// 位置：~/.pi/agent/extensions/env-guard/index.ts（全域生效，jiti 直接跑 TS；
// 也可整包用 pi install git:github.com/Artin0123/harness-plugins 安裝）

import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 不直接信 os.tmpdir()：TEMP 可能是 "/tmp" 這種 MSYS 映射值，而 Node 對它
// 會驗證失敗後回退（實測 TEMP=TMP=/tmp 時回退到使用者 temp）——回退值不
// 保證等於 bash 的 /tmp 錨點（自訂 fstab 會錯位），所以錨點還是要問 bash
// 本身。但也不要預設 AppData 佈局：
// bash 的 /tmp 靠 /etc/fstab 掛載（Git for Windows 預設 usertemp，但自訂 fstab
// 可指向任何地方）。正確解：問「pi 實際會 spawn 的 bash」本身 `cygpath -w /tmp`
// ——那才是 bash 的 `> /tmp/x` 與檔案工具看同一個目錄的錨點；探不到就用
// os.tmpdir()（它讀 TEMP，是環境事實；但只有磁碟路徑才算數），兩者都拿不到
// 就回 null（＝不改寫：依「找不到就整體停用」，不去猜 AppData 這類佈局慣例）。
//
// 惰性求值：探測要 spawn 兩顆行程（uname + cygpath，實測 ~370ms），不能在
// 模組載入時就付（pi 也不會用到檔案工具的命令照樣載入擴充）。
let tempAnchor: string | null | undefined; // undefined＝尚未探測；null＝探不到錨點
// bash 偵測結果快取（findBash 會被 realTempDir 與 pathConvDisabled 多次呼叫，
// 掃描+uname 驗證有成本，結果算一次就定）
let bashCache: string | null | undefined;

// ===== 探測對象：pi 實際會 spawn 的 shell =====
// 兩項改寫（/tmp 錨點、MSYS_NO_PATHCONV 閘門）都盡量問「真的會執行命令的那顆
// shell」，否則就是猜。pi 的設定值（settings.shellPath）由 factory 注入：
//   有設 → 只信它：驗證是 MSYS bash 才拿來探測；不是（pwsh/cmd/WSL/Cygwin）→ null，
//          cmd 旗標改寫直接停用（`//c` 的故障點是 MSYS 轉換層的事）；temp 錨點
//          則退回 os.tmpdir() 這個環境事實（有的話）——檔案工具不管 shell 是什麼
//          都在 host 端解析，`/tmp` 一樣會錯位，所以不全面停用。
//   沒設 → pi 自己會去挑 git-bash，用 findBash() 的掃描+驗證結果
let configuredShell: (() => string | undefined) | null = null;
let probeShellCache: string | null | undefined;

export function setConfiguredShell(fn: () => string | undefined): void {
  configuredShell = fn;
}

function probeShell(): string | null {
  if (probeShellCache !== undefined) return probeShellCache;
  probeShellCache = null;
  try {
    const configured = configuredShell?.();
    if (configured) {
      if (existsSync(configured) && verifyMsysBash(configured)) probeShellCache = configured;
      return probeShellCache; // 設定值存在就只信它（非 MSYS → gate 停用）
    }
  } catch { /* 讀不到設定 → 退回偵測 */ }
  probeShellCache = findBash();
  return probeShellCache;
}

export function realTempDir(): string | null {
  if (tempAnchor !== undefined) return tempAnchor;
  tempAnchor = null;
  try {
    const bash = probeShell();
    if (bash) {
      const p = spawnSync(bash, ["-c", "cygpath -w /tmp"], { timeout: 5000, windowsHide: true });
      const out = (p.stdout?.toString() ?? "").trim();
      if (!p.error && /^[A-Za-z]:[\\/]/.test(out)) tempAnchor = out;
    }
  } catch { /* 保持 null */ }
  if (tempAnchor === null) {
    const t = os.tmpdir();
    if (/^[A-Za-z]:[\\/]/.test(t)) tempAnchor = path.normalize(t);
  }
  return tempAnchor;
}

// ===== MSYS 路徑轉換探測（決定 cmd //c 是否該改寫成 /c）=====
// 改寫方向取決於 bashrc 的 MSYS_NO_PATHCONV，而 bashrc 對本擴充不可見。
// 但 bash -c 會 source 它（BASH_ENV），所以探測子 shell 看到的實際值，結果快取一次：
//   轉換關閉（MSYS_NO_PATHCONV 存在，不論值）→ //c 原樣抵達 cmd、進互動模式 → 啟用改寫
//   轉換開啟（預設 git-bash，變數不存在）→ //c 是唯一能動的拼法，改寫它本身就是副作用 → 不改寫
//   探測失敗／找不到 bash → 不改寫（fail-safe：漏修的話 cmd 會印橫幅失敗，
//   模型可自行修正；誤修則是沉默破壞正確語法——寧可漏修，不可誤修）
// MSYS 的判定是「變數存在即停用」（實測 //c 在 0／空字串／false 下都原樣抵達
// 原生程式），所以探測只問存在性，不比對值。
// 前提：探測對象＝實際 spawn 的 bash（settings.shellPath，由 factory 注入；
// 沒設才退回 findBash() 的掃描）——兩者同源，沒有「探測 ≠ spawn」的漂移。
let noPathConvCache: boolean | null = null;

// ---- bash 自動偵測（掃描 + 驗證身份，不寫死任何安裝路徑）----
// 陷阱：C:\Windows\System32\bash.exe 是 WSL 啟動器（永遠在 PATH 且常排前面）；
// 天真掃 PATH 會抓到它。正確解是「掃描 + 驗證」：每個候選都用 `uname -s` 驗
// 身份——Git Bash = MINGW*_NT-*、MSYS2 = MSYS_NT-*、WSL = Linux、
// Cygwin = CYGWIN_NT-*（別信 OSTYPE：Git Bash 回報 "cygwin"，無法判別）。
// 全部落空 → 回傳 null，相關功能整體停用（inert）：漏修的 cmd 大聲失敗
// 可自修，猜錯路徑後的結果是靜默出錯。
// 候選來源（依優先序，刻意不做套件管理器列舉）：
//   1. PATH 掃描（僅跳過 System32——WSL stub 所在地）
//   2. PATH 上的 git.exe 反推安裝根目錄；同目錄若有 git.shim 則解析 path= 拿
//      真實位置。shim 是必要分支：scoop 這類安裝既不把 bash.exe 放上 PATH
//      也不寫註冊表，git.shim 是唯一的軌跡；winget/choco/Ninite 的 git.exe
//      本尊就在 PATH 上，用不到這分支。這是通用的「跟著 git.exe 找」，
//      不針對任何套件管理器——它們要么把 git 放上 PATH，要么走同一個
//      安裝程式寫下 GitForWindows 註冊表鍵，兩者都已覆蓋。
//   3. Git for Windows 註冊表鍵（安裝程式式安裝會登記 InstallPath）
//   4. 環境變數推導的程式根目錄（覆蓋無註冊表的使用者層安裝）
const MSYS_UNAME = /^(MINGW|MSYS)/;

// Git for Windows 安裝程式登記的註冊表鍵
const GIT_REG_KEYS = [
  "HKLM\\SOFTWARE\\GitForWindows",
  "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
  "HKCU\\SOFTWARE\\GitForWindows",
];

function verifyMsysBash(candidate: string): boolean {
  try {
    const p = spawnSync(candidate, ["-c", "uname -s"], { timeout: 5000, windowsHide: true });
    return !p.error && MSYS_UNAME.test((p.stdout?.toString() ?? "").trim());
  } catch {
    return false;
  }
}

function registryBashRoots(): string[] {
  const roots: string[] = [];
  for (const key of GIT_REG_KEYS) {
    try {
      const p = spawnSync("reg", ["query", key, "/v", "InstallPath"], {
        timeout: 5000,
        windowsHide: true,
      });
      const m = /InstallPath\s+REG_SZ\s+(.+)/i.exec(p.stdout?.toString() ?? "");
      if (m) roots.push(m[1]!.trim());
    } catch { /* 鍵不存在或 reg 不可用 */ }
  }
  return roots;
}

function extraBashRoots(): string[] {
  const envRoots = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git"),
  ].filter((p): p is string => Boolean(p));
  return [...registryBashRoots(), ...envRoots];
}

// 從安裝根目錄推導 bash 候選（Git for Windows 兩個位置都可能）
function bashCandidatesFromRoot(root: string, out: string[], seen: Set<string>) {
  const add = (p: string) => {
    const k = p.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  };
  add(path.join(root, "usr", "bin", "bash.exe"));
  add(path.join(root, "bin", "bash.exe"));
}


export function findBash(): string | null {
  if (bashCache !== undefined) return bashCache;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const k = p.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  };
  const pathDirs = (process.env.PATH ?? "").split(";").filter(Boolean);

  // 1) 單次 PATH 掃描：每個目錄可能有 bash.exe 本尊，或 git.exe 可反推安裝根。
  //    這是通用邏輯—— winget/choco/Ninite 都把 Git\cmd 放上 PATH，與其他安裝
  //    同一個迴圈覆蓋，不需特例。找到即回傳；registry/env 根目錄只在 PATH
  //    全軍覆沒時才查（省去每次啟動的 3 個 reg query 子行程）。
  for (const d of pathDirs) {
    const base = d.replace(/[\\]+$/, "");
    if (/\\System32(\\|$)/i.test(base)) continue; // WSL 啟動器 stub 所在地
    add(path.join(base, "bash.exe"));
    const git = path.join(base, "git.exe");
    if (!existsSync(git)) continue;
    let root = path.dirname(git); // 通常是 <安裝根>\cmd
    // shim 只是轉發器：真實 git.exe 的路徑在旁邊的 git.shim（path=，值可能帶引號）。
    // 只有 PATH 上的 git.exe 是 shim 時才會走到這（見上方候選來源註解）。
    const shim = path.join(root, "git.shim");
    if (existsSync(shim)) {
      try {
        const m = /^path\s*=\s*(.+)$/im.exec(readFileSync(shim, "utf8"));
        if (m) root = path.dirname(m[1]!.trim().replace(/^"+|"+$/g, ""));
      } catch { /* shim 讀不了就當作沒有 */ }
    }
    bashCandidatesFromRoot(path.dirname(root), out, seen);
  }
  for (const c of out) {
    if (existsSync(c) && verifyMsysBash(c)) { bashCache = c; return c; }
  }
  // 2) 註冊表 + 環境變數推導的根目錄，最後手段（同樣過 uname 驗證才算數）
  const out2: string[] = [];
  const seen2 = new Set<string>(out.map((p) => p.toLowerCase()));
  for (const root of extraBashRoots()) bashCandidatesFromRoot(root, out2, seen2);
  for (const c of out2) {
    if (existsSync(c) && verifyMsysBash(c)) { bashCache = c; return c; }
  }
  bashCache = null;
  return null;
}

export function pathConvDisabled(): boolean {
  if (noPathConvCache === null) {
    noPathConvCache = false; // 失敗時維持「不改寫」
    try {
      const bash = probeShell();
      if (bash) {
        // 問存在性而非值：${VAR+set} 在變數已設（含空字串）時輸出 "set"
        const p = spawnSync(bash, ["-c", 'printf %s "${MSYS_NO_PATHCONV+set}"'], {
          timeout: 5000,
          windowsHide: true,
        });
        noPathConvCache = !p.error && p.stdout?.toString().trim() === "set";
      }
    } catch {
      /* keep false */
    }
  }
  return noPathConvCache;
}

// 在 s 中從 from 開始找與 "$(" 配對的 ")"，回傳其索引；找不到回傳 -1。
// 需理解 bash 的巢狀：引號會重新開啟語境，但引號內的 $( )、反引號仍會作用，
// 單引號則完全字面。遞迴處理雙引號內的命令取代。
function matchParen(s: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      let p = i + 1;
      while (p < s.length && s[p] !== "'") p++;
      i = p + 1;
      continue;
    }
    if (c === '"') {
      let p = i + 1;
      while (p < s.length && s[p] !== '"') {
        if (s[p] === "\\") {
          p += 2;
          continue;
        }
        if (s[p] === "$" && s[p + 1] === "(") {
          const cl = matchParen(s, p + 2);
          if (cl === -1) return -1;
          p = cl + 1;
          continue;
        }
        if (s[p] === "`") {
          let q2 = p + 1;
          while (q2 < s.length && s[q2] !== "`") {
            if (s[q2] === "\\") q2++;
            q2++;
          }
          p = q2 + 1;
          continue;
        }
        p++;
      }
      i = p + 1;
      continue;
    }
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

export function rewritePath(p: string): string {
  // 故障點只在 Windows 的 tool 解析層（host 端不經 MSYS 映射、不展開變數）；
  // 其他平台的 /tmp、$TEMP 本來就是它們的語意，動它就是誤修。
  if (process.platform !== "win32") return p;
  // 拿不到 bash 的 /tmp 錨點 → 不改寫（不猜佈局，見上方 realTempDir）
  const realTemp = realTempDir();
  if (!realTemp) return p;
  // 接續部分統一用反斜線，避免混合分隔符（Windows API 雖兩者通吃，但輸出乾淨一致）
  const norm = (rest: string) => realTemp + rest.replace(/\//g, "\\");
  let m: RegExpExecArray | null;
  // POSIX /tmp（MSYS 掛載不分大小寫、混合分隔符也擋：/tmp、/TMP/x、/tmp\foo）
  m = /^\/tmp([\\/].*)?$/i.exec(p);
  if (m) return norm(m[1] ?? "");
  // MSYS 盤符路徑（/c/Users/...）：刻意不修——pi 的檔案工具解析層
  // （resolveToCwd → normalizeWindowsShellPath）原生就把 /c/Users/x 正確映射成
  // C:\Users\x（含 /mnt/d、/cygdrive/e），實測 e2e 無 C:\c 錯位。盤符修復只在
  // 沒有這層正規化的 host（cmdc）才合理；在 pi 是重複防護＝純副作用。
  // bash/cmd 風格的暫存變數：工具不展開任何變數，$TEMP 曾實際建成字面資料夾。
  // $TEMP/$TMP/$TMPDIR（含 bash 的 ${TEMP} 大括號形式）不分大小寫與分隔符全擋
  //（工具語境下任何寫法都不可能展開；實測 write '${TEMP}/x' 會在專案裡
  // 建出字面 ${TEMP} 資料夾）
  m = /^\$(?:temp|tmp|tmpdir)([\\/].*)?$/i.exec(p);
  if (m) return norm(m[1] ?? "");
  m = /^\$\{(?:temp|tmp|tmpdir)\}([\\/].*)?$/i.exec(p);
  if (m) return norm(m[1] ?? "");
  // cmd 風格 %TEMP%/%TMP%：同樣不被展開 → 字面 %TEMP% 資料夾
  m = /^%(?:temp|tmp)%([\\/].*)?$/i.exec(p);
  if (m) return norm(m[1] ?? "");
  // C:\tmp：刻意不修——原生寫入會成功（合法 Windows 路徑），原生不壞就不修。
  // 裸 nul / NUL：刻意不修。重測（轉換開／關皆驗）本機 bash 在 cwd 建實體
  // nul 檔（見檔頭）——bash 原生行為、非工具層問題，不修
  return p;
}

// 前綴賦值路徑值轉換（bash 掃描器用）：重現原生 git-bash envp 轉換層對
// 「值是 POSIX 絕對路徑」的不變式規則（name-agnostic——轉換層只看值語法，
// 不猜哪個變數是路徑；實測 FOO/RANDOMNAME/XDG_CACHE_HOME 一視同仁）。
// 範圍刻意只有兩個可驗證錨點：
//   盤符形 /c、/c/… → C:/…（實測原生輸出大寫盤符＋正斜線，輸入不分大小寫）
//   /tmp、/tmp/…   → cygpath 錨點（實測原生 envp 轉換輸出正斜線風格）
// 不修：根相對路徑（/usr…——原生映射到 MSYS 安裝根，非不變式）、含 : 的清單值
// （原生清單轉換是另一套規則，輸出 C:\a;C:\b）、含 \ 的值（cmd-ism）。
// 回傳 null ＝ 不修（掃描器照原樣保留）。
function convertEnvPath(v: string): string | null {
  if (/[:\\]/.test(v)) return null; // 清單分隔符／cmd-ism：另一套規則，不碰
  let m = /^\/([a-zA-Z])(\/.*)?$/.exec(v);
  if (m) return m[1]!.toUpperCase() + ":" + (m[2] ?? "/");
  m = /^\/tmp(\/.*)?$/i.exec(v);
  if (m) {
    const anchor = realTempDir();
    if (!anchor) return null; // 問不到錨點就不修（不猜佈局）
    return anchor.replace(/\\/g, "/") + (m[1] ?? "");
  }
  return null;
}

// bash 指令改寫（語法感知掃描器，單次掃描處理兩件事）：
//   1. cmd //c|//k → cmd /c|/k：MSYS 慣用的雙斜線旗標在 MSYS_NO_PATHCONV=1 下
//      會原樣抵達 cmd，cmd 不認得就進互動模式（印橫幅、指令沒跑、exit 0）——
//      沉默的錯。只在「指令位置」的 cmd 才改寫（echo cmd //c 等資料用法不動）
//      範圍界定（為何只修 cmd、不預防性擴及 git/npx/python/pwsh）：那些工具吃
//      -/-- 參數，msys 轉換層不碰 - 開頭的參數，MSYS_NO_PATHCONV 開關對它們
//      沒有可觀察影響——不是選擇性不修，是它們沒有這個故障模式。雙斜線慣用
//      語法存在於所有以 / 為 switch 前綴的原生程式：除了 cmd.exe，還有 taskkill、
//      sc、net、reg、robocopy、findstr 這類可直接從 bash 呼叫的 Windows 內建
//      工具——實測 taskkill //IM x //F 在原生 git-bash 成功、本機（轉換關閉）
//      原樣抵達而 exit 1 大聲報錯，與 //c 同一個故障點。它們維持刻意漏修：
//      失敗是大聲的（stderr＋exit 1，agent 看到即自癒——事件實錄裡的「靜默」
//      是模型自己加 >/dev/null 2>&1 遮掉的，屬模型自身錯誤、不介入），且靜態
//      修復必須列舉「哪些程式吃 / 旗標」＝開放集合＋猜測。cmd 單獨納入的依據：
//      失敗是靜默的（互動模式、exit 0、橫幅偽裝成輸出），又是 OS shell（bash
//      到不了的 OS 設施都得經它，e2e 實測自然觸發）。判準是故障點所在層：
//      此故障在「本機轉換層被 MSYS_NO_PATHCONV 關閉（存在即停用）」，模型語法（git-bash
//      官方慣用法）與程式本身都無錯。將來若有別的工具出現「自然使用＋
//      故障可歸因於本機環境層＋靜默失敗」三條全中的實例，再按同一標準納入。
//   2. 前綴賦值的 POSIX 路徑值 → Windows 值：VAR=/c/foo node … 在原生 git-bash
//      會經 envp 轉換成 C:/foo，本機轉換被 MSYS_NO_PATHCONV 關閉 → 值原樣抵達
//      node、被當磁碟相對路徑解析成 C:\c\foo（靜默錯位）。只在「指令位置的
//      賦值前綴＋後接指令字」改寫（規則與不修形態見 convertEnvPath 與檔頭）。
// 語法感知規則：
//   - 單引號/雙引號內的字面「> nul」是資料，不動（cmd //c "dir > nul" 引號內交給 cmd）
//   - heredoc 本體是資料，不動；結束標記行整行原樣跳過（同列殘字非標記，bash 會視為本體）
//   - 反斜線跳脫的字元不構成運算子
//   - 反引號與 $( ) 內是指令位置（會真的執行）；FOO=bar 前綴不結束指令位置
//   - POSIX 語法關鍵字（if/then/elif/else/fi/while/until/do/done/time、{、}、！）
//     與 env/exec/command/builtin（bash 內建/POSIX 標準、後接指令字的閉集合）
//     在指令位置時不結束指令位置，所以 `if cmd //c ver; then …`、`env cmd //c
//     ver` 的 cmd 仍算指令位置；外部 wrapper（timeout/env 選項後/nice/xargs…
//     ）刻意不列（見檔頭「漏修臺」）
//   - 重導向/`<`/`)` 之後不延續 cmd 旗標區：目標是 bash 自己解析的路徑，不是 argv
//   - heredoc 終止符按 bash 規則整行等值比對（`<<-` 先去掉前導 tab），不用 trim()
//   - heredoc 定界符是 bash 的 word：`<<'END OF FILE'`（引號內任意內容）、
//     `<<\EOF`（跳脫＝字面化）都算；辨識不到就會把本體當指令改寫
//   - 替換/分隔符收尾要清 token 狀態：`echo `y` cmd`、`echo $(cmd) //x` 的
//     cmd 與 //x 都是 echo 的參數，不能授權改寫；`x=`y` cmd` 相反的
//     （替換是賦值內容）則仍是指令位置，bash 真的跑 cmd
//   - 括號收尾也要還原外層位置（反引號的 btPos 同理）：`count=$(…) cmd` 是
//     賦值值（cmd 會執行）而 `$(…) cmd` 的替換本身就是指令名（cmd 只是參數）
//     ——由「`(` 前一字元」與 commit 後的指令位置天然分流；`foo( … )` 函式
//     定義維持 true；群組 `( … ) word` 原生就是語法錯誤 → false
//   - 2>&1 的 & 不是分隔符（前一字元是 > ）
//   - 前綴賦值在指令位置時暫存（記下它在 out 的跨度與改寫結果），「真指令
//     字」落地才套用——此時值確定會經 exec 邊界進該 simple command 的
//     envp。真指令字＝非賦值（含空值 B=）、非語法關鍵字、非 BUILTIN_WORD
//     （bash 內建與 bash/sh：值不經 msys→native 邊界——實測 A=/c/x
//     eval 'echo $A' 與 A=/c/x bash -c 'echo $A' 原生皆 [/c/x]；這些詞的
//     動態範圍内 spawn native 時原生會轉，排除＝那側漏修，方向安全）、
//     非純數字詞（fd 前綴；實測 A=/c/x 2>&1 原生持久化 [/c/x]）。
//     收尾＝standalone 賦值（shell 變數，bash 端語意
//     需要 POSIX 值）→ 丟棄：分隔符／重導向（含 fd 前綴 2>…）／heredoc／
//     EOF／詞首 `#` 註解。`(` 不丟：緊貼形 VAR=/c/x$(…) 靠組合律（前綴改
//     寫＋逐字後綴＝對串接後完整值的原生轉換；前提＝動態尾部以 / 開頭，
//     否則原生把整值當根相對路徑、組合律不成立——實測 A=/c$(echo foo)
//     原生 → <msys-root>/cfoo）；實測 A=x (…)、A=x foo() {…} 是 syntax
//     error，不存在需要保守的合法形。多筆由右至左套用，記錄時的跨度不受
//     後續附加影響。
//     殘餘邊界（如實）：函式名是開放集合、無法靜態排除，且是混合邊界
//     ——body 内 spawn native 時原生會轉（實測 f(){ node …; }; A=/c/x f
//     → C:/x，與改寫一致）、body 直接讀值時原生不轉（實測 f(){ echo
//     [$A]; } → [/c/x]，改寫發散）；維持套用偏向 spawn 情形（多數形），
//     讀值情形為罕見且靜默的誤修；其他 msys 程式（git/cat…）同為開放
//     集合、同樣雙向。引號指令字不被掃描器當 token（A=/c/x "node" 單獨形＝漏修，原生會轉換；帶參數時由後續詞
//     觸發而正確）；重導向交錯形（A=/c/x 2>&1 cmd、A=/c/x > log node）＝
//     漏修（原生會轉換）；靜態前綴止於盤符的緊貼形（VAR=/c$(…) ：暫存值
//     /c$ 不符合轉換規則、不記錄）＝漏修——漏修方向安全。
export interface BashScanResult {
  command: string;
  cmdFlagFixed: boolean;  // cmd //c|//k 被改寫為 /c|/k
  envPathFixed: boolean;  // 前綴賦值的 POSIX 路徑值被改寫（VAR=/c/… → VAR=C:/…）
}

export function rewriteBashCommand(command: string): BashScanResult {
  const r = scanBash(command);
  return {
    command: r.command,
    cmdFlagFixed: r.cmdFlagFixed,
    envPathFixed: r.envPathFixed,
  };
}

function scanBash(command: string): BashScanResult {
  // heredoc 定界符是 bash 的 word：加引號時可含任意內容（`<<'END OF FILE'`，
  // 終止行去引號比對），也可寫成 `<<\EOF`（跳脫＝字面化，定界符是 EOF）。
  // 辨識不到就會把本體當指令掃描（＝改到資料）；起始字仍限字母/底線，
  // 避免把 `$((1<<2))` 這種算術位移誤當 heredoc。
  const heredoc = /<<(-?)[ \t]*(?:(["'])([^\r\n]+?)\2|\\?([A-Za-z_][A-Za-z0-9_.-]*))/y; // sticky 已錨定 lastIndex
  const cmdFlag = /\/\/([A-Za-z]+)(?![\w.-])/iy; // cmd 旗標都是字母（/v:on 這類冒號參數自然保留在後）
  // 指令位置不結束的固定集合（bash 語法/內建層，閉集合）——不是「猜哪些程式
  // 會轉發指令」：if/while/{/!/time 是語法關鍵字；exec/command/builtin 是 bash
  // 內建、env 是 POSIX 標準程式，四者後接的第一個非選項詞就是被執行的指令
  //（實測 env/exec/command cmd //c ver 原生跑 ver、本機進互動模式——與裸
  // cmd //c 同一故障；與 oc 版 SHELL_KEYWORDS 對齊）。界線仍在 shell 語法層
  // ：timeout/nice/xargs 這類外部 wrapper 的參數結構才是開放集合（見檔頭漏修臺）
  //。刻意大小寫敏感：大寫 ENV 是路徑上的程式名、IF/TIME 不是 bash 關鍵字。
  const RESERVED_WORD = /^(?:if|then|elif|else|fi|while|until|do|done|time|exec|command|builtin|env|[{}!])$/;

  // 指令字排除集（觸發套用的反集合）——值「不經 msys→native exec 邊界」
  // 的閉集合，兩類：
  // 1) bash 內建（本機 enable -a 可列舉，＋ . [ 與 [[ ]] 特殊語法詞）：內建
  //    本身不 spawn；但 eval/source 這類特殊內建的動態範圍内 spawn 原生程
  //    式時原生會轉（實測 A=/c/x eval 'node …' 原生 C:/x）——字串會做什麼
  //    無法靜態判定；排除＝純內建情形與原生一致（實測 A=/c/x eval
  //    'echo $A' 原生 [/c/x]）、動態範圍 spawn 情形＝漏修（安全方向）。
  // 2) bash/sh：msys 程式，msys→msys 邊界不轉 envp（實測 A=/c/x bash -c
  //    'echo $A' 原生 [/c/x]）；內層再 spawn native 時原生在內層邊界補轉
  //    （實測 C:/x）、此處漏修——同上安全方向。
  // exec/command/env 刻意不列：RESERVED_WORD 續位、由後面的真指令字觸發
  // （command node / env node 的 node 是 native、值經邊界）。函式名與其他
  // msys 程式（git/cat…）是開放集合、無法靜態排除 → 殘餘混合邊界，如實
  // 記錄（見檔頭語法感知規則）。純數字詞（fd 前緣，2>&1 的 2）也不觸發
  // （實測 A=/c/x 2>&1 原生持久化 [/c/x]）。刻意大小寫敏感（與 RESERVED_WORD 同）
  // 。防漂移：測試電池把本集合與 enable -a 逐一對照。
  const BUILTIN_WORD = /^(?:\.|:|\[|\[\[|\]\]|alias|bg|bind|break|builtin|bash|caller|cd|compgen|compopt|complete|continue|declare|dirs|disown|echo|enable|eval|exit|export|false|fc|fg|getopts|hash|help|history|jobs|kill|let|local|logout|mapfile|popd|printf|pushd|pwd|read|readarray|readonly|return|set|sh|shift|shopt|source|suspend|test|times|trap|true|type|typeset|ulimit|umask|unalias|unset|wait)$/;
  let out = "";
  let i = 0;
  const n = command.length;
  let pendingDelim: string | null = null;
  let pendingStripTabs = false; // <<- ：終止符行先去掉前導 tab 再比（bash 只去 tab，不去空白）
  let inHeader = false;
  let cmdFlagFixed = false;
  let envPathFixed = false;
  // 前綴賦值暫存：賦值 token 在指令位置時記下它在 out 的跨度與改寫後整詞，
  // 等後續「指令字」落地（＝值確定會進該 simple command 的 envp）才套用。
  // 多筆由右至左套用（記錄時的跨度不受後續右側附加影響）。
  let pendingEnv: { start: number; end: number; rep: string }[] = [];
  // token 追蹤：判斷 cmd 是否在「指令位置」（可執行處），避免改到字面資料
  let curTok = "";
  let prevTok = "";
  let prevTokCmdPos = false;
  let cmdPosNext = true;
  let cmdFlagZone = false; // cmd 之後的旗標區（cmd //q //c 的第二個旗標也要改）
  let inBacktick = false; // 反引號開/關（\` 由跳脫分支吃掉，所以是單層）
  const btPos: boolean[] = []; // 每層反引號開頭的「外層是否在指令位置」
  // 括號堆疊：每個 ( 記下「收尾時要還原的指令位置」
  //   foo(  → true（函式定義，後面接 { … } 群組，cmd 仍在指令位置）
  //   $(    → 還原 commit 後的位置：賦值前綴（count=$(…)）→ true，bash 真的跑 cmd；
  //           獨立替換（$(…)）→ false，替換結果本身就是指令名，後面的 cmd 只是參數
  //   群組 ( → false（`( … ) word` 原生就是語法錯誤，不改寫）
  const parenRestore: boolean[] = [];
  // case 樣式的 `)`（`case x in a) …`）在 bash 語法上沒有對應的 `(`：它終止樣式、
  // 開 body，若讓它 pop 就會偷走外層 $( 的堆疊項。所以照 bash 語法追蹤區段
  //（這段註解是唯一防腐劑，別當不明狀態碼刪）：
  //   case（在命令位置）備位 → 該 case 的 `in` 開「樣式區」
  //   樣式區的 `)`：無對應 (、**不 pop 外層堆疊**（只收選配的 `( 樣式 )` 包裹）、
  //                  重開命令位置並進入 body
  //   `;;`（只有 ;;；單一 ; 是 body 內的指令分隔）→ 回樣式區；`esac` → 結束
  //   body 內的 `)` 一律是普通括號、照常 pop 還原——否則 case body 裡的 $( )
  //   會被誤判成樣式 `)`，把 echo 的參數當命令改寫（實測踩過）
  let caseRegion: "none" | "pattern" | "body" = "none";
  let casePending = false; // 看過 `case`、還沒看到它的 `in`

  const isCmdTok = (t: string) => {
    const l = t.toLowerCase();
    return l === "cmd" || l === "cmd.exe";
  };

  // 收尾/分隔符要把 token 狀態一起清掉：替換內累積的 prevTok（如 `echo $(cmd) //x`
  // 的 cmd）不能授權外面的改寫，否則 //x 這種 echo 的參數會被當 cmd 旗標改寫。
  const clearTok = () => {
    prevTok = "";
    prevTokCmdPos = false;
    cmdFlagZone = false;
  };

  // 套用暫存的前綴賦值改寫。gate：轉換層沒被 MSYS_NO_PATHCONV 關閉＝原生
  // 會自己轉，不改（重複防護），此時直接丟掉暫存、不套用。
  const applyPendingEnv = () => {
    if (!pendingEnv.length) return;
    if (!pathConvDisabled()) {
      pendingEnv = [];
      return;
    }
    for (let k = pendingEnv.length - 1; k >= 0; k--) {
      const r = pendingEnv[k]!;
      out = out.slice(0, r.start) + r.rep + out.slice(r.end);
    }
    envPathFixed = true;
    pendingEnv = [];
  };

  const commitTok = () => {
    if (!curTok) return;
    prevTokCmdPos = cmdPosNext;
    if (cmdPosNext) {
      // FOO=bar 環境變數前綴、與 if/while/{/! 等語法關鍵字都不結束指令位置
      cmdPosNext = RESERVED_WORD.test(curTok) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(curTok);
    }
    // case 區段追蹤（語法見上方註解）：`case` 要在命令位置才算；`in` 在參數位置，
    // 位置 gate 不適用，所以只認「看過 case」（casePending）
    const lowTok = curTok.toLowerCase();
    if (lowTok === "case" && prevTokCmdPos) casePending = true;
    else if (lowTok === "in" && casePending) { caseRegion = "pattern"; casePending = false; }
    else if (lowTok === "esac") { caseRegion = "none"; casePending = false; }
    // 旗標區維持規則：cmd 本身開啟旗標區；區內的 /旗標（含剛改寫的）不關閉；其他 token 關閉
    if (cmdFlagZone && !curTok.startsWith("/")) cmdFlagZone = false;
    if (prevTokCmdPos && isCmdTok(curTok)) cmdFlagZone = true;
    // 前綴賦值路徑改寫的暫存／套用：賦值 token（整詞未引號、值可轉換）在
    // 指令位置 → 暫存；非賦值、非語法關鍵字的 token 在指令位置落地 ＝
    // simple command 的指令字 → 此時暫存賦值確定會進它的 envp，套用。
    // prevTokCmdPos 此時仍是本 token 的位置（commitTok 開頭賦的值）。
    if (prevTokCmdPos) {
      // 賦值判定與 keeper/EOF 一致（含空值 B=）：空值賦值既不暫存（無可轉換
      // 值）也不觸發套用——套用必須是「真指令字」（見 BUILTIN_WORD 註解）
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(curTok)) {
        const em = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(curTok);
        if (em) {
          const conv = convertEnvPath(em[2]!);
          if (conv) pendingEnv.push({ start: out.length - curTok.length, end: out.length, rep: em[1]! + "=" + conv });
        }
      } else if (!RESERVED_WORD.test(curTok) && !BUILTIN_WORD.test(curTok) && !/^\d+$/.test(curTok)) {
        applyPendingEnv();
      }
    }
    prevTok = curTok;
    curTok = "";
  };

  // 双引號內的 $( ) 與 `…` 會真的被 bash 執行（如 R="$(cmd //c ver)"），
  // 必須遞迴掃描；引號本身是字面，但命令取代區域內是完整 shell 語法
  const scanDq = (seg: string): string => {
    let s = "";
    let k = 0;
    const m2 = seg.length;
    while (k < m2) {
      const c = seg[k];
      if (c === "$" && seg[k + 1] === "(") {
        const close = matchParen(seg, k + 2);
        if (close === -1) {
          s += seg.slice(k);
          break;
        }
        const sub = scanBash(seg.slice(k + 2, close));
        s += "$(" + sub.command + ")";
        cmdFlagFixed ||= sub.cmdFlagFixed;
        envPathFixed ||= sub.envPathFixed;
        k = close + 1;
        continue;
      }
      if (c === "`") {
        let p = k + 1;
        while (p < m2 && seg[p] !== "`") {
          if (seg[p] === "\\") p++;
          p++;
        }
        if (p >= m2) {
          s += seg.slice(k);
          break;
        }
        const sub = scanBash(seg.slice(k + 1, p));
        s += "`" + sub.command + "`";
        cmdFlagFixed ||= sub.cmdFlagFixed;
        envPathFixed ||= sub.envPathFixed;
        k = p + 1;
        continue;
      }
      s += c;
      k++;
    }
    return s;
  };

  while (i < n) {
    // heredoc 本體：逐行原樣複製；結束標記行整行跳過（標記行殘字視為本體，同 bash）
    // 終止符照 bash 規則比：<< 要整行等於 delimiter；<<- 先去掉前導 tab 再比。
    // 不能用 trim()——bash 不把空白差異當終止符，提早結束會讓「仍是本體」的資料
    // 被當指令掃描、進而改寫（`cat <<'EOF'` 後一行 `  EOF` 就是這種案例）。
    // 只容許行尾一個 \r：CRLF 文字下 bash 的 delimiter 也帶 \r，兩邊一起去掉才等價。
    if (pendingDelim !== null && !inHeader) {
      let lineEnd = command.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = n;
      const rawLine = command.slice(i, lineEnd);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if ((pendingStripTabs ? line.replace(/^\t+/, "") : line) === pendingDelim) {
        out += command.slice(i, Math.min(lineEnd + 1, n));
        i = lineEnd + 1;
        pendingDelim = null;
        curTok = "";
        clearTok();
        cmdPosNext = true; // 標記行後是新指令列
        continue;
      }
      out += command.slice(i, Math.min(lineEnd + 1, n));
      i = lineEnd + 1;
      continue;
    }
    const ch = command[i];
    if (ch === "\n" && pendingDelim !== null && inHeader) {
      out += "\n";
      i++;
      inHeader = false;
      curTok = "";
      clearTok();
      continue;
    }
    if (ch === "\\") {
      const seg = command.slice(i, i + 2);
      out += seg;
      curTok += seg; // 跳脫字元屬於當前詞（\> 不構成運算子）
      i += 2;
      continue;
    }
    if (ch === "'") {
      commitTok();
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        const seg = command.slice(i);
        out += seg;
        break;
      }
      const seg = command.slice(i, end + 1);
      out += seg;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      commitTok();
      // 找關閉引號：$() 與反引號內會重新開啟引號語境，需跳過整個命令取代區域
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") {
          j += 2;
          continue;
        }
        if (command[j] === "$" && command[j + 1] === "(") {
          const close = matchParen(command, j + 2);
          if (close === -1) {
            j = n;
            break;
          }
          j = close + 1;
          continue;
        }
        if (command[j] === "`") {
          let p = j + 1;
          while (p < n && command[p] !== "`") {
            if (command[p] === "\\") p++;
            p++;
          }
          j = p + 1;
          continue;
        }
        j++;
      }
      if (j >= n) {
        const seg = command.slice(i);
        out += scanDq(seg); // 未閉合引號內的 $() 同樣會執行
        break;
      }
      const seg = command.slice(i, j + 1);
      out += scanDq(seg);
      i = j + 1;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      commitTok();
      heredoc.lastIndex = i;
      const m = heredoc.exec(command);
      if (m) {
        pendingDelim = m[3] ?? m[4]!;
        pendingStripTabs = m[1] === "-";
        inHeader = true;
        out += m[0];
        i += m[0].length;
        pendingEnv = []; // heredoc 重導向＝賦值沒接指令字（A=x <<EOF 是 standalone）→ 丟棄
        continue; // 標記行同列的重導向照常掃描（cmd 旗標偵測仍需要）
      }
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      commitTok();
      if (ch === "\n") {
        cmdPosNext = true; // 新的一行：上一行的 cmd 不能授權本行的改寫
        clearTok();
        pendingEnv = []; // 新指令列＝賦值沒接指令字（standalone）→ 丟棄
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "(") {
      commitTok();
      // 只有 `;;` 會把 body 拉回樣式區；單一 `;` 只是 body 內的指令分隔
      if (ch === ";" && command[i + 1] === ";" && caseRegion === "body") caseRegion = "pattern";
      // 管線／指令結束＝前綴賦值沒接上指令字（standalone）→ 丟棄。`(` 不丟：
      // 緊貼的 VAR=/c/x$(…) 是賦值值的動態組合（見函式頭註解）；A=x (…) 是
      // syntax error，沒有需要保守的合法形。
      if (ch === "|" || ch === ";") pendingEnv = [];
      if (ch === "(") {
        // cmdPosNext 此時是 commit 後的值：`count=$(` 會被 assignment 前綴保
        // 留在 true，`$(` 則已被 commit 成一個普通 word → false（天然分流）
        // 樣式區裡的 `(`（`case x in (a) …` 的選配包裹）不推堆疊：它的 `)` 就是
        // 樣式終止符，由下面的 region 分支處理
        const prev = command[i - 1] ?? "";
        if (caseRegion !== "pattern") parenRestore.push(prev === "$" ? cmdPosNext : /[A-Za-z0-9_]/.test(prev));
      }
      clearTok();
      cmdPosNext = true; // 分隔符後是新的指令位置（含 $( 與反引號開頭）
      out += ch;
      i++;
      continue;
    }
    if (ch === "&") {
      commitTok();
      if (command[i - 1] !== ">" && command[i - 1] !== "<") {
        clearTok();
        cmdPosNext = true; // 2>&1 的 & 不是分隔符
        pendingEnv = []; // 背景分離＝賦值沒接指令字（standalone）→ 丟棄
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === ">" || ch === "<") {
      commitTok();
      let restoreTrue = false;
      if (ch === ")") {
        if (caseRegion === "pattern") {
          // 樣式終止：不 pop（防止偷走外層 $( 的堆疊項），重開命令位置並進 body
          cmdPosNext = true;
          caseRegion = "body";
        } else {
          // 還原這個括號對應的位置；stack 空就維持現況
          const restore = parenRestore.pop();
          if (restore !== undefined) cmdPosNext = restore;
          restoreTrue = restore === true;
        }
      }
      // 重導向目標由 bash 自己開檔（不經被關掉的 argv 轉換層），`)` 也結束該指令：
      // 兩者都清掉指令上下文，否則下一個詞會被當旗標改寫成資料/路徑。
      // 同時丟棄暫存賦值（A=x > log node 這種交錯形列為漏修：重導向後掃描器
      // 已當參數區，見上「重導向之後不延續」）。例外：`$(` 關閉且還原到指令
      // 位置＝緊貼形 A=/c/x$(…) 的值組合還沒收尾——賦值仍在等後面的真指令字
      //（內建的 pwd/echo 等已不再觸發套用），這個 `)` 不丟，讓暫存流到指令字。
      if (!restoreTrue) pendingEnv = [];
      clearTok();
      out += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      // 同一個 ` 分支兼管開/關：開的時候指令位置從頭算（內容是會執行的指令），
      // 關的時候還原外層該有的位置——`x=``y`` cmd` 這種「替換是賦值內容」
      // 後面仍是指令位置（bash 真的跑 cmd）；`echo ``y`` cmd`、`FOO=bar ``y`` cmd`
      // 的替換本身就是指令名，cmd 只是它的參數 → 不再是指令位置。
      const inWord = curTok !== "";
      commitTok();
      if (!inBacktick) {
        btPos.push(inWord && cmdPosNext);
        inBacktick = true;
        cmdPosNext = true;
      } else {
        inBacktick = false;
        cmdPosNext = btPos.length ? btPos.pop()! : false;
      }
      clearTok();
      out += ch;
      i++;
      continue;
    }
    // cmd 的雙斜線旗標：僅當 cmd 出現在指令位置（含緊貼形 cmd//c）
    if (ch === "/" && command[i + 1] === "/") {
      const atCmd =
        curTok === ""
          ? (prevTokCmdPos && isCmdTok(prevTok)) || (cmdFlagZone && prevTok.startsWith("/"))
          : cmdPosNext && isCmdTok(curTok);
      if (atCmd && pathConvDisabled()) {
        cmdFlag.lastIndex = i;
        const m = cmdFlag.exec(command);
        if (m) {
          // 緊貼形 cmd//c：cmd 已寫入 out，需補空格分離程式名與旗標
          out += (curTok === "" ? "" : " ") + "/" + m[1];
          i += m[0].length;
          curTok = "/" + m[1];
          cmdFlagFixed = true;
          continue;
        }
      }
      curTok += ch;
      out += ch;
      i++;
      continue;
    }
    // bash 註解（# 在詞首——bash 只在詞首認註解）：註解讓前綴賦值收尾成
    // standalone（`A=/c/x # c` 是 shell 變數賦值、值不進任何 envp，原生也
    // 不轉換）→ 丟棄暫存；丟棄要在 # 這個詞自己 commit 之前（詞首 # 在指令
    // 位置會被當指令字觸發套用）。詞中的 #（a#b）不是註解，照常掃描；
    // 註解內容照一般掃描——資料位置不會誤觸改寫， # 後面的指令字若真被
    // 授權也只落在永不執行的死文字上。
    if (ch === "#" && curTok === "") {
      pendingEnv = [];
    }
    curTok += ch;
    out += ch;
    i++;
  }
  // EOF：檔尾 token 沒有分隔符觸發 commit——真指令字落在檔尾時前綴賦值一樣
  // 要套用（A=/c/x cmd 的 cmd 就是這種）。賦值（含空值）、語法關鍵字、
  // 內建、純數字詞＝收尾 standalone → 丟棄；參數位置照舊不套用。
  if (curTok && cmdPosNext && !RESERVED_WORD.test(curTok) && !BUILTIN_WORD.test(curTok) && !/^\d+$/.test(curTok) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(curTok)) {
    applyPendingEnv();
  }
  return { command: out, cmdFlagFixed, envPathFixed };
}

// ===== 使用統計 =====
// 計數清單內工具的呼叫次數與各修復的觸發次數，量測外掛實際命中率。分類學
// 與 OC 兄弟共用：
//   分母  toolCalls[tool]——清單內工具每次呼叫 +1，且都在 gate 之後
//        （非 win32 提前 return、handler 只在 gate 後註冊，所以
//        統計範圍＝外掛實際作用的範圍）
//   分子  fixes[key]——真的改寫才 +1，以故障點為 key；同性質的
//        variant 合併（/tmp、$TEMP、${TEMP}、%TEMP% 都是 "path.temp"；
//        //c、多旗標都是 "shell.cmdFlag"；前綴賦值的盤符與 /tmp 形都是
//        "shell.envPath"），不同類型分開。三個鍵對應三個不同故障層：host
//        工具路徑解析層、msys argv 旗標轉換層、msys envp 賦值值轉換層
//        （後兩者根因同為 MSYS_NO_PATHCONV，但失敗模式與修法不同，合併會
//        看不出哪層在觸發）。
// 儲存：pi 不提供 per-extension 儲存 API（docs/extensions.md 的 State 段：
// session 外的資料＝external storage，由擴充自選），所以放 pi 自己的
// agent 目錄——getAgentDir() 是 pi 官方匯出的路徑（吃 PI_CODING_AGENT_DIR
// 覆蓋），不自己復刻路徑邏輯。檔案：~/.pi/agent/env-guard-stats.json，
// 直接開檔即看。寫入：分子即時落盤（觸發低頻）、分母 5 秒 debounce
// ＋session_shutdown 補冲；tmp+rename 避免讀到半截 JSON。任何失敗都
// 吞掉：統計絕不能影響工具執行。

const STATS_FILE = "env-guard-stats.json";

interface Stats {
  schema: 1;
  since: string;
  toolCalls: Record<string, number>;
  fixes: Record<string, number>;
}

let stats: Stats | null = null;
let statsFileCache: string | null | undefined; // undefined＝未解析；null＝解析失敗（只留記憶體計數）
let statsTimer: ReturnType<typeof setTimeout> | undefined;

function adoptCounts(saved: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (saved && typeof saved === "object") {
    for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    }
  }
  return out;
}

export function statsSnapshot(): Stats | null {
  return stats && { ...stats, toolCalls: { ...stats.toolCalls }, fixes: { ...stats.fixes } };
}

function statsFile(): string | null {
  if (statsFileCache !== undefined) return statsFileCache;
  statsFileCache = null;
  try {
    const dir = getAgentDir();
    if (typeof dir === "string" && dir) statsFileCache = path.join(dir, STATS_FILE);
  } catch {
    /* pi API 不可用：只留記憶體計數 */
  }
  return statsFileCache;
}

// 讀檔-合併：沿用先前 run 累積的計數（jiti reload／新 session 的 module
// 重新載入後，記憶體從零開始，不清掉歷史）
function loadStats(): void {
  if (stats) return;
  const file = statsFile();
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Stats>;
      if (saved && typeof saved === "object" && saved.schema === 1 && typeof saved.since === "string") {
        stats = { schema: 1, since: saved.since, toolCalls: adoptCounts(saved.toolCalls), fixes: adoptCounts(saved.fixes) };
        return;
      }
    } catch {
      /* 不存在/讀不了/壞檔：重新開始 */
    }
  }
  stats = { schema: 1, since: new Date().toISOString(), toolCalls: {}, fixes: {} };
}

function persistStats(): void {
  const file = statsFile();
  if (!file || !stats) return;
  try {
    const tmp = `${file}.${process.pid}.tmp`; // per-PID: concurrent sessions must not rename each other's half-written file
    writeFileSync(tmp, JSON.stringify(stats, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch {
    /* 統計失敗不影響工具執行 */
  }
}

function flushStats(): void {
  if (statsTimer) {
    clearTimeout(statsTimer);
    statsTimer = undefined;
  }
  persistStats();
}

function bumpTool(tool: string): void {
  loadStats();
  if (!stats) return;
  stats.toolCalls[tool] = (stats.toolCalls[tool] ?? 0) + 1;
  if (!statsTimer) {
    statsTimer = setTimeout(flushStats, 5000); // 分批：每次呼叫不該付一次磁碟寫入
    statsTimer.unref?.(); // 不擋 pi 退出（session_shutdown 會補冲）
  }
}

function bumpFix(key: string): void {
  loadStats();
  if (!stats) return;
  stats.fixes[key] = (stats.fixes[key] ?? 0) + 1;
  flushStats(); // 分子低頻：立即落盤
}

const notifyUI = (ctx: { hasUI: boolean; ui: { notify: (msg: string, level?: string) => void } }, msg: string, level: string) => {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(msg, level);
  } catch {
    try {
      ctx.ui.notify(msg, "info");
    } catch {
      /* 通知失敗不影響工具執行 */
    }
  }
};

export default function (pi: ExtensionAPI) {
  // 故障點全部是 Windows 的（host 端路徑解析、MSYS 轉換層）：非 Windows 整個擴充
  // 停用（那種機器上沒有 cmd.exe）
  if (process.platform !== "win32") return;
  // 探測對象＝ pi 自己配置的 shell（settings.shellPath）；有設就只信它，
  // 沒設才退回 findBash() 的掃描。這樣就不必「假設」pi 會 spawn 哪顆 bash。
  setConfiguredShell(() => {
    try {
      const s = pi.getSettings?.();
      return typeof s?.shellPath === "string" && s.shellPath ? s.shellPath : undefined;
    } catch {
      return undefined;
    }
  });
  // session 結束：把分母 debounce 還沒寫出的部分補冲
  pi.on("session_shutdown", () => flushStats());

  pi.on("tool_call", (event, ctx) => {
    const name = event.toolName;

    // write / edit / read / grep / find / ls：改寫 path 參數
    //（grep/find/ls 同樣是 host 端解析（resolveToCwd），/tmp/$TEMP 也會出事，
    //  但它們是唯讀工具，失敗型態是「找不到目錄」大聲報錯——修掉是純獲益）
    if (name === "write" || name === "edit" || name === "read" || name === "grep" || name === "find" || name === "ls") {
      bumpTool(name);
      const input = event.input as { path?: string };
      if (typeof input?.path === "string") {
        const rewritten = rewritePath(input.path);
        if (rewritten !== input.path) {
          const from = input.path;
          input.path = rewritten;
          bumpFix("path.temp");
          notifyUI(
            ctx,
            `env-guard: path rewritten ${from} -> ${rewritten}`,
            "info",
          );
        }
      }
      return;
    }

    // bash：cmd //c 旗標修正
    //（bash 內的 /tmp 經 MSYS 映射本來就正確，不需動）
    if (name === "bash") {
      bumpTool("bash");
      const input = event.input as { command?: string };
      if (typeof input?.command === "string") {
        const r = rewriteBashCommand(input.command);
        if (r.command !== input.command) {
          input.command = r.command;
        }
        if (r.cmdFlagFixed) {
          bumpFix("shell.cmdFlag");
          notifyUI(
            ctx,
            "env-guard: cmd //c flag rewritten to /c (MSYS_NO_PATHCONV is set, so msys path conversion is off and //c would start an interactive cmd)",
            "info",
          );
        }
        if (r.envPathFixed) {
          bumpFix("shell.envPath");
          notifyUI(
            ctx,
            "env-guard: env assignment path rewritten (MSYS_NO_PATHCONV is set, so msys env conversion is off and POSIX values would reach the program verbatim, e.g. /c/foo resolving to C:\\c\\foo)",
            "info",
          );
        }
      }
    }
  });
}
