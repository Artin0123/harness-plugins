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
//     適用 cmd 與 cmd.exe、指令位置（含 if/while/{/!/time 等 POSIX 語法關鍵字
//     之後）的全部 //字母旗標（含多旗標 cmd //q //c）。
//
// 【刻意不修】原生行為或模型自身錯誤，一概讓它壞：
//   - wrapper 指令後的 cmd（timeout 5 cmd //c …、env cmd //c …、xargs …）：
//     原生（轉換開啟）可跑、本機被同一層弄壞，但要在指令位置判定裡跳過
//     wrapper 的參數，就得知道每個 wrapper 的參數結構——開放集合＋猜測，
//     違反「只留不變的部分」，故列為刻意漏修（漏修＝原生失敗，方向安全）。
//   - 原生程式的 POSIX 路徑參數（`git -F /tmp/x`、`git hash-object /tmp/x`、
//     `python /tmp/x.py`…）：預設 git-bash 靠 argv 轉換才成立，本機轉換關閉就
//     變成 `could not open '/tmp/…'`（實測；MSYS 程式如 cat/ls 不受影響）。
//     不修的理由：判斷「哪個參數是路徑」需要各程式自己的參數語義（開放集合
//     ＋猜測），把所有 /… 參數硬改成 Windows 路徑又會改壞字串／regex
//     （`echo /tmp`、`grep /tmp`、`sed 's|/tmp|X|'`）；且失敗是大聲的，agent 可自癒。
//   - 絕對路徑 cmd（C:\…\cmd.exe //c）、引號形式（"cmd" //c）、跳脫（\cmd //c）：
//     同樣是原生可跑、本機壞，但模型實務不會這樣寫，加了只是多一個作用點。
//   - 原生就壞的雙斜線形（cmd //?、cmd ///c、cmd //server/share）：實測轉換
//     開啟時一樣進互動模式 → 模型自己寫錯，不修。
//   - case 樣式的 `)`（`case $x in a) cmd //c ver;; esac`、以及它包在 `$( )` 裡的
//     形）：bash 語法上這個 `)` 沒有對應的 `(`，要修得追蹤 case/in/esac 狀態，
//     而 case body 裡合法的 `$( )` 一旦誤判（該 pop 變成不 pop）就會把資料改壞
//     ——實測目前只落在漏修側（資料不會被改寫），故維持不追蹤（已釘樁）。
//   - 重導向目標的雙斜線（`cmd //c "x" > //out`）：目標路徑是 bash 自己開檔時
//     解析的，根本不經被 MSYS_NO_PATHCONV 關掉的 argv 轉換層——沒有故障點；
//     原生就是大聲失敗（`//out: Is a directory`），改寫它反而會靜默寫到
//     別的位置（`> /tmp/eg.log` 真的建檔），所以目標原樣不動。
//   - C:\tmp：write 工具寫 C:\tmp 原生會成功（合法 Windows 路徑）——原生不壞就不修，
//     模型真寫 C:\tmp 就讓它寫。
//   - nul 重導向（> nul、2>nul…）：實測 bash（與 pi spawn 同一顆）把裸 nul 映射到
//     丟棄裝置——多數形態根本不建檔；只有在同 process 先開過 /dev/null 的
//     命令形態（如 `x > nul 2>/dev/null`）才會因 MSYS 裝置映射失效建出實體檔。
//     這是 bash 原生行為（無 pi 介入也一樣），且是模型寫 cmd-ism 的自身錯誤，
//     不符合介入判準；殘留檔 `rm nul` 即可刪。write 工具 path="nul" 同理
//     （Node host 端原生就會建真檔，非 pi 加工）。
//   - < nul：bash 直接報 ENOENT，錯誤訊息自己會說話
//   - 2>&nul、<&nul：ambiguous redirect，大聲失敗且不造檔
//   - 其他 cmd-ism（del、dir /b、robocopy //mir…）：不是所有 shell 語法都能無風險改寫
//
// 位置：~/.pi/agent/extensions/env-guard/index.ts（全域生效，jiti 直接跑 TS；
// 也可整包用 pi install git:github.com/Artin0123/harness-plugins 安裝）

import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 不直接信 os.tmpdir()：若 pi 是從 git-bash 啟動，TEMP 可能是 "/tmp" 這種
// MSYS 映射值，Node 直接拿去用會再踩同樣的坑。但也不要預設 AppData 佈局：
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
// 前提：探測對象現在是 pi 自己的設定值（settings.shellPath，由 factory 注入；
// 沒設才退回 findBash() 的掃描）。設定值是 MSYS bash 才探測、否則整體 inert，
// 所以不再存在「探測的 bash ≠ 實際 spawn 的 bash」這種漂移。
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
  // 裸 nul / NUL：刻意不修。實測 bash 把裸 nul 映射到丟棄裝置（多數形態不建檔），
  // 會建檔的形態是 MSYS 原生行為（見檔頭），非工具層問題
  return p;
}

// bash 指令改寫（語法感知掃描器，單次掃描處理兩件事）：
//   1. cmd //c|//k → cmd /c|/k：MSYS 慣用的雙斜線旗標在 MSYS_NO_PATHCONV=1 下
//      會原樣抵達 cmd，cmd 不認得就進互動模式（印橫幅、指令沒跑、exit 0）——
//      沉默的錯。只在「指令位置」的 cmd 才改寫（echo cmd //c 等資料用法不動）
//      範圍界定（為何只修 cmd、不預防性擴及 git/npx/python/pwsh）：那些工具吃
//      -/-- 參數，msys 轉換層不碰 - 開頭的參數，MSYS_NO_PATHCONV 開關對它們
//      沒有可觀察影響——不是選擇性不修，是它們沒有這個故障模式。雙斜線慣用
//      語法只存在於以 / 為 switch 前綴的程式，Windows 上即 cmd.exe（OS shell，
//      bash 到不了的 OS 設施都得經它，e2e 實測自然觸發）。判準是故障點所在層：
//      此故障在「本機轉換層被 MSYS_NO_PATHCONV 關閉（存在即停用）」，模型語法（git-bash
//      官方慣用法）與 cmd.exe 本身都無錯。將來若有別的工具出現「自然使用＋
//      故障可歸因於本機環境層＋靜默失敗」三條全中的實例，再按同一標準納入。
//   2. 偵測「cmd + 非 ASCII」：只警告、不改寫。實測機制：cmd 的輸出照 console
//      code page（本機 936＝GBK）編碼，pi 的 bash-executor 一律以 UTF-8 解碼 stdout
//      → 中文變亂碼；argv 反而會正確送達（`type 中文.txt` 讀得到、`dir /b 中文*`
//      匹配得到），只有該 code page 表示不了的字（emoji）變 '?'。不可在命令層修：
//      注入 `chcp 65001` 實測不忠實（同一條命令有時輸出 UTF-8、有時仍是 GBK，
//      且會把內建訊息語言切掉：ver 的「版本」變 "Version"）；tool_result 拿到的
//      又是 host 解碼後的文字（原始 bytes 已遺失）→ 正確修法在 host 的解碼層（權限
//      外），所以維持只警告。
// 語法感知規則：
//   - 單引號/雙引號內的字面「> nul」是資料，不動（cmd //c "dir > nul" 引號內交給 cmd）
//   - heredoc 本體是資料，不動；結束標記行整行原樣跳過（同列殘字非標記，bash 會視為本體）
//   - 反斜線跳脫的字元不構成運算子
//   - 反引號與 $( ) 內是指令位置（會真的執行）；FOO=bar 前綴不結束指令位置
//   - POSIX 語法關鍵字（if/then/elif/else/fi/while/until/do/done/time、{、}、!）
//     在指令位置時不結束指令位置，所以 `if cmd //c ver; then …` 的 cmd 仍算
//     指令位置；wrapper 指令（timeout/env/xargs…）刻意不列（見檔頭「刻意不修」）
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
//   - cmdNonAscii 是全命令掃描（不是只看 cmd 的 argv）：`echo 中文; cmd /c ver`
//     也會報警告。只是提示、不改命令，所以容忍這個誤報而不另做區間追蹤。
export interface BashScanResult {
  command: string;
  cmdFlagFixed: boolean;  // cmd //c|//k 被改寫為 /c|/k
  cmdNonAscii: boolean;   // 指令位置的 cmd + 非 ASCII（僅警告）
}

export function rewriteBashCommand(command: string): BashScanResult {
  const r = scanBash(command);
  return {
    command: r.command,
    cmdFlagFixed: r.cmdFlagFixed,
    cmdNonAscii: r.sawCmd && r.nonAscii,
  };
}

function scanBash(command: string): BashScanResult & { sawCmd: boolean; nonAscii: boolean } {
  // heredoc 定界符是 bash 的 word：加引號時可含任意內容（`<<'END OF FILE'`，
  // 終止行去引號比對），也可寫成 `<<\EOF`（跳脫＝字面化，定界符是 EOF）。
  // 辨識不到就會把本體當指令掃描（＝改到資料）；起始字仍限字母/底線，
  // 避免把 `$((1<<2))` 這種算術位移誤當 heredoc。
  const heredoc = /<<(-?)[ \t]*(?:(["'])([^\r\n]+?)\2|\\?([A-Za-z_][A-Za-z0-9_.-]*))/y; // sticky 已錨定 lastIndex
  const cmdFlag = /\/\/([A-Za-z]+)(?![\w.-])/iy; // cmd 旗標都是字母（/v:on 這類冒號參數自然保留在後）
  // POSIX 語法關鍵字：固定集合（bash 語法），不是「猜哪些程式會轉發指令」
  const RESERVED_WORD = /^(?:if|then|elif|else|fi|while|until|do|done|time|[{}!])$/;
  const nonAsciiRe = /[^\x00-\x7F]/;
  let out = "";
  let i = 0;
  const n = command.length;
  let pendingDelim: string | null = null;
  let pendingStripTabs = false; // <<- ：終止符行先去掉前導 tab 再比（bash 只去 tab，不去空白）
  let inHeader = false;
  let cmdFlagFixed = false;
  let sawCmd = false;
  let nonAscii = false;
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

  const commitTok = () => {
    if (!curTok) return;
    prevTokCmdPos = cmdPosNext;
    if (cmdPosNext) {
      sawCmd = sawCmd || isCmdTok(curTok);
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
        sawCmd ||= sub.sawCmd;
        nonAscii ||= sub.nonAscii;
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
        sawCmd ||= sub.sawCmd;
        nonAscii ||= sub.nonAscii;
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
      if (nonAsciiRe.test(seg)) nonAscii = true;
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
        if (nonAsciiRe.test(seg)) nonAscii = true;
        out += seg;
        break;
      }
      const seg = command.slice(i, end + 1);
      if (nonAsciiRe.test(seg)) nonAscii = true; // 引號內非 ASCII 仍會抵達 cmd（cmd /c "echo 中文"）
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
        if (nonAsciiRe.test(seg)) nonAscii = true;
        out += scanDq(seg); // 未閉合引號內的 $() 同樣會執行
        break;
      }
      const seg = command.slice(i, j + 1);
      if (nonAsciiRe.test(seg)) nonAscii = true;
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
        continue; // 標記行同列的重導向照常掃描（cmd 旗標偵測仍需要）
      }
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      commitTok();
      if (ch === "\n") {
        cmdPosNext = true; // 新的一行：上一行的 cmd 不能授權本行的改寫
        clearTok();
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "(") {
      commitTok();
      // 只有 `;;` 會把 body 拉回樣式區；單一 `;` 只是 body 內的指令分隔
      if (ch === ";" && command[i + 1] === ";" && caseRegion === "body") caseRegion = "pattern";
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
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === ">" || ch === "<") {
      commitTok();
      if (ch === ")") {
        if (caseRegion === "pattern") {
          // 樣式終止：不 pop（防止偷走外層 $( 的堆疊項），重開命令位置並進 body
          cmdPosNext = true;
          caseRegion = "body";
        } else {
          // 還原這個括號對應的位置；stack 空就維持現況
          const restore = parenRestore.pop();
          if (restore !== undefined) cmdPosNext = restore;
        }
      }
      // 重導向目標由 bash 自己開檔（不經被關掉的 argv 轉換層），`)` 也結束該指令：
      // 兩者都清掉指令上下文，否則下一個詞會被當旗標改寫成資料/路徑
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
    if (nonAsciiRe.test(ch)) nonAscii = true;
    curTok += ch;
    out += ch;
    i++;
  }
  return { command: out, cmdFlagFixed, sawCmd, nonAscii };
}

// ===== 使用統計 =====
// 計數清單內工具的呼叫次數與各修復的觸發次數，量測外掛實際命中率。分類學
// 與 OC 兄弟共用：
//   分母  toolCalls[tool]——清單內工具每次呼叫 +1，且都在 gate 之後
//        （非 win32 提前 return、handler 只在 gate 後註冊，所以
//        統計範圍＝外掛實際作用的範圍）
//   分子  fixes[key]——真的改寫/警告才 +1，以故障點為 key；同性質的
//        variant 合併（/tmp、$TEMP、${TEMP}、%TEMP% 都是 "path.temp"；
//        //c、多旗標都是 "shell.cmdFlag"），不同類型分開
//        （shell.cmdNonAscii 是警告型「修復」，也記一筆）。
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
  // 停用，連 cmd+非 ASCII 警告也不發（那種機器上沒有 cmd.exe）
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

    // bash：cmd //c 旗標修正、cmd+非 ASCII 警告
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
        if (r.cmdNonAscii) {
          bumpFix("shell.cmdNonAscii");
          notifyUI(
            ctx,
            "env-guard: cmd + non-ASCII - measured: cmd writes output in the console code page (936/GBK here) while pi decodes stdout as UTF-8, so it arrives as mojibake; characters outside that code page become '?'. No faithful rewrite exists (injecting chcp 65001 is non-deterministic and switches built-in messages to English), so prefer bash-native tools or PowerShell-native commands for non-ASCII work",
            "warning",
          );
        }
      }
    }
  });
}
