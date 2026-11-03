// env-guard.ts — 防護 pi 在 Windows 上的路徑與 shell 事故。
// 使用者視角與安裝：README.md；刻意不修／漏修的逐條病理與實測證據：docs/spec.md
//（注意：手動安裝的副本不會帶走 repo 的 docs，註解只留判準、證據在 spec）。
// 此處與程式內註解只留「讀懂、防誤改所需」的內容。
//
// 優先序：原生執行最優先——原生就會壞的讓它壞（工具回傳≡原生，agent 看到
// 真實原因、可自癒）；只修「本環境的轉換/處理層弄壞」的失敗（回傳≠原生，
// 大聲或靜默都是漏修，大聲≠豁免）；探測/閘門失敗一律不改寫（寧可漏修、
// 不可誤修）。
//
// 三個修復（故障點都在 Windows 的工具/轉換層；細節見各自函式註解）：
//   1. 檔案工具（write/edit/read/grep/find/ls）的 path：/tmp、$TEMP、
//      %TEMP% … → 真實 temp（rewritePath；錨點 realTempDir／probeShell）
//   2. bash 的 cmd //c|//k → /c|/k：MSYS_NO_PATHCONV 讓 //c 原樣抵達 cmd、
//      進互動模式（靜默錯）（scanBash；閘門 pathConvDisabled）
//   3. bash 前綴賦值的 POSIX 路徑值 → Windows 值：原生 envp 轉換會轉、本機
//      停用 → /c/foo 被 node 當磁碟相對路徑解析成 C:\c\foo（靜默錯位）
//      （convertEnvPath；掃描器 scanBash）
//
// 不修的事（此處只列清單防回歸誤加；逐條病理與實測在 spec）：
//   刻意不修（回傳≡原生）：C:\tmp、nul 重導向與 <nul/2>&nul、重導向目標的
//     雙斜線（bash 自己開檔、不經被關掉的 argv 轉換層）、原生就壞的 cmd
//     雙斜線形（//? ///c //server/share）、緊貼形（cmd//c／"cmd"//c：bash 把它
//     當程式名、原生 127 大聲失敗——插空格拆詞＝替模型改錯字）、exec/command/
//     builtin 後的賦值形與引號詞裡的偽賦值形（bash 把它當指令名跑、原生就
//     大聲失敗）、del 與 dir /b 等 cmd-ism
//   漏修（回傳≠原生，但靜態修法＝開放集合的猜測、誤修風險大於漏修）：
//     外部 wrapper 後的 cmd、taskkill/sc/net/reg/findstr/robocopy 等原生
//     工具的 //x 旗標、原生 exe 的 POSIX 路徑參數、
//     反斜線換行續接後的 cmd //c（\⟨newline⟩ 被當跳脫對併進 token、指令字
//     身分失效）、bash -c '…' 引號內的指令碼、envp 殘餘值形（env 選項交錯形
//     env -u V X=…、賦值值的引號/清單/根相對形等；見 convertEnvPath 與 spec
//     「envp 殘餘形」）、指令字串裡成對的反斜線抵達 bash 時只剩一個（病灶已
//     量到：git-bash 對 `-c` 操作數的引號處理把成對反斜線縮一層，stdin／檔案
//     傳輸保真；資訊在 hook 之前就丟了，加倍反斜線會破壞合法的跳脫＝誤修，
//     見 spec 臺帳）、算術位移的識別字運算元（`$((1<<N))`／`((x<<N))`：`<<N`
//     被當 heredoc 開頭、等不到定界符 → 換行後整段不再改寫＝其後的 cmd 旗標
//     與 envp 全部漏修；與 `$((1<<2))` 同形，兩側都靜態不可分，見 spec）
//   已知邊界（誤修、有機頻率 ~0，記錄不修）：未引號定界符第一字不是數字/字母/
//     底線（`<<*X`、`<<.E`、`<<$S`…，實測合法）與純數字 `<<3`——掃描器不認得，
//     本體會被當指令掃描；放寬第一字會把 `$((x<<$y))` 這類算術誤判成 heredoc，
//     兩個方向都是猜，見 spec 臺帳


import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { getAgentDir, getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// ===== 探測對象：pi 實際會 spawn 的 shell =====
// 兩項改寫（/tmp 錨點、MSYS_NO_PATHCONV 閘門）都問「真的會執行命令的那顆
// shell」，否則就是猜。pi 的 spawn 決策就是 getShellConfig(settings.shellPath)
//（agent-session 讀 settings → bash 工具 → getShellConfig）；擴充呼叫同一個
// 函式＝由構造保證探測對象≡spawn 對象——先前的自製掃描（findBash）解析順序
// 與 pi 不同（pi 先看 Program Files 的 Git，掃描先看 PATH），在「Program Files
// 有 Git ＋ PATH 上另有 MSYS2」的機器上兩者會漂移，已移除。settings.shellPath
// 由 factory 注入（pi.getSettings）；getShellConfig 找不到 shell、或 settings.
// shellPath 指到不存在的檔（它對這兩種都 throw）→ probeShell 回 null（整體
// inert）。回傳的 shell 也可能非 MSYS（pwsh、PATH
// fallback 不跳 System32 → 可能是 WSL 啟動器）→ verifyMsysBash 擋下：cmd 旗標
// 改寫停用、錨點退 os.tmpdir()——與 pi 真的 spawn 該 shell 的原生行為一致。
let configuredShell: (() => string | undefined) | null = null;
let probeShellCache: string | null | undefined;
// 宿主能力缺失的紀錄（只在 tool_call 的第一個呼叫通知一次）：pi 的
// getShellConfig 自 0.48.0 起才 export（CHANGELOG #766）。舊宿主上 import 會是
// undefined → 下面丟錯被吞、整體 inert——依「閘門失敗一律停用」正確，但
// 默默停用看不出原因，所以記下來在第一次工具呼叫時告知。
let hostGap: string | null = null;
let hostGapNotified = false;

export function setConfiguredShell(fn: () => string | undefined): void {
  configuredShell = fn;
}

function probeShell(): string | null {
  if (probeShellCache !== undefined) return probeShellCache;
  probeShellCache = null;
  if (typeof getShellConfig !== "function") {
    // 舊 pi（< 0.48.0）沒這個 export：探測對象不可得＝不改寫（寧可漏修）
    hostGap = "this pi version does not export getShellConfig (needs >= 0.48.0); shell probe disabled, so no rewriting";
    return probeShellCache;
  }
  try {
    const cfg = getShellConfig(configuredShell?.()) as { shell?: unknown } | undefined;
    const shell = cfg?.shell;
    if (typeof shell === "string" && shell && existsSync(shell) && verifyMsysBash(shell)) {
      probeShellCache = shell;
    }
  } catch {
    /* 無 bash／pi API 失敗 → null＝整體不改寫（寧可漏修，不可誤修） */
  }
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
// 前提：探測對象＝getShellConfig(configuredShell?.())＝pi 實際 spawn 的 shell
//——兩者同一個呼叫，沒有「探測 ≠ spawn」的漂移。
let noPathConvCache: boolean | null = null;

// ---- shell 身分驗證 ----
// getShellConfig 不驗身份：PATH fallback（`where bash.exe` 取第一個命中）不跳
// System32，可能挑到 WSL 啟動器。用 `uname -s` 驗——Git Bash = MINGW*_NT-*、
// MSYS2 = MSYS_NT-*、WSL = Linux、Cygwin = CYGWIN_NT-*（別信 OSTYPE：Git Bash
// 回報 "cygwin"，無法判別）。非 MSYS → 不拿來探測（該 shell 沒有 MSYS 轉換層
// 故障點，改寫即誤修）。
const MSYS_UNAME = /^(MINGW|MSYS)/;

function verifyMsysBash(candidate: string): boolean {
  try {
    const p = spawnSync(candidate, ["-c", "uname -s"], { timeout: 5000, windowsHide: true });
    return !p.error && MSYS_UNAME.test((p.stdout?.toString() ?? "").trim());
  } catch {
    return false;
  }
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

// 統計分類：temp 修復的兩個**不同故障點**（不是同名 variant）：
//   tempMount＝`/tmp` 這種 MSYS 掛載路徑——host 不套 MSYS 映射，解析到碟根
//   tempVar＝`$TEMP`／`%TEMP%` 這種變數——host 根本不展開，建成字面資料夾
// 兩者結果一樣（→ 真實 temp）但機制不同，修好一邊≠修好另一邊，所以分開計。
// （`shell.envPath` 不拆：碟符值與 /tmp 值都是「同一個」envp 轉換層被關掉。）
// **單一來源**：族別與後缀都在這裡決定，改寫與計數都問它——兩套 regex 並存時，
// 新增一個形態只改到一邊就會計入錯的鍵（label 與動作脫釣）。
const TEMP_FAMILIES: { kind: "path.tempMount" | "path.tempVar"; re: RegExp }[] = [
  // POSIX /tmp（MSYS 掛載不分大小寫、混合分隔符也擋：/tmp、/TMP/x、/tmp\foo）
  { kind: "path.tempMount", re: /^\/tmp([\\/].*)?$/i },
  // bash/cmd 風格的暫存變數：工具不展開任何變數，$TEMP 曾實際建成字面資料夾
  //（$TEMP/$TMP/$TMPDIR、bash 的 ${TEMP} 大括號、cmd 的 %TEMP%/%TMP%）
  { kind: "path.tempVar", re: /^\$(?:temp|tmp|tmpdir)([\\/].*)?$/i },
  { kind: "path.tempVar", re: /^\$\{(?:temp|tmp|tmpdir)\}([\\/].*)?$/i },
  { kind: "path.tempVar", re: /^%(?:temp|tmp)%([\\/].*)?$/i },
];

// 回傳族別與接續部分（rest）；不屬於 temp 族 → null
function splitTempPath(p: string): { kind: "path.tempMount" | "path.tempVar"; rest: string } | null {
  for (const f of TEMP_FAMILIES) {
    const m = f.re.exec(p);
    if (m) return { kind: f.kind, rest: m[1] ?? "" };
  }
  return null;
}

export function classifyTempFix(p: string): "path.tempMount" | "path.tempVar" | null {
  return splitTempPath(p)?.kind ?? null;
}

// 回傳「改寫後的值 + 族別」：族別給統計用，值給工具用——同一次判斷同時餵兩邊，
// 所以「改了值卻記到錯的鍵」在結構上不可能（hook 不需要再自己分類）。
export function rewritePathFix(p: string): { value: string; kind: "path.tempMount" | "path.tempVar" | null } {
  const none = { value: p, kind: null as null };
  // 故障點只在 Windows 的 tool 解析層（host 端不經 MSYS 映射、不展開變數）；
  // 其他平台的 /tmp、$TEMP 本來就是它們的語意，動它就是誤修。
  if (process.platform !== "win32") return none;
  // 拿不到 bash 的 /tmp 錨點 → 不改寫（不猜佈局，見上方 realTempDir）
  const realTemp = realTempDir();
  if (!realTemp) return none;
  // 接續部分統一用反斜線，避免混合分隔符（Windows API 雖兩者通吃，但輸出乾淨一致）
  const norm = (rest: string) => realTemp + rest.replace(/\//g, "\\");
  // temp 族（族別與接續部分由 splitTempPath 決定，與統計共用同一份 regex）
  const hit = splitTempPath(p);
  if (hit) return { value: norm(hit.rest), kind: hit.kind };
  // MSYS 盤符路徑（/c/Users/...）：刻意不修——pi 的檔案工具解析層
  // （resolveToCwd → normalizeWindowsShellPath）原生就把 /c/Users/x 正確映射成
  // C:\Users\x（含 /mnt/d、/cygdrive/e），實測 e2e 無 C:\c 錯位。盤符修復只在
  // 沒有這層正規化的 host（cmdc）才合理；在 pi 是重複防護＝純副作用。
  // C:\tmp：刻意不修——原生寫入會成功（合法 Windows 路徑），原生不壞就不修。
  // 裸 nul / NUL：刻意不修。重測（轉換開／關皆驗）本機 bash 在 cwd 建實體
  // nul 檔（實測見 docs/spec.md）——bash 原生行為、非工具層問題，不修
  return none;
}

// 薄包裝：只回值（測試與呼叫端習慣）
export function rewritePath(p: string): string {
  return rewritePathFix(p).value;
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
//   1. cmd //c|//k → /c|/k：轉換關閉時 //c 原樣抵達 cmd、進互動模式（靜默錯）。
//      只在「指令位置」改寫（echo cmd //c 等資料位置不動）；指令位置涵蓋獨立
//      成詞的引號指令字（"cmd" //c、A=/c/x "bash" …——引號不改變 word 身分
//      ，引號内含 $()/跳脫時不命中任何閉集合）；為何只修 cmd、其他 //x 工具
//      為何留在漏修臺：docs/spec.md「刻意不修與漏修的分界」。
//   2. 前綴賦值的 POSIX 路徑值 → Windows 值：只在「指令位置的賦值前綴＋後接
//      指令字」改寫（值形錨點見 convertEnvPath；殘餘值形＝漏修，清單與逐條
//      實測見 spec「envp 殘餘形」）。暫存-套用模型見 pendingEnv／
//      applyPendingEnv 註解；緊貼形 VAR=/c/x$(…) 的組合律見 `(` 分支。
// 指令位置判定與 token 狀態機規則逐條寫在各分支的行內註解（引號／heredoc／
// 括號堆疊／反引號／替換收尾／註解行）；兩個閉集合界定在 RESERVED_WORD／
// BUILTIN_WORD；所有形態都有測試釘樁（../tests/env-guard/index.mjs）。
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
  // 終止行去引號比對；空引號 `<<""` 也是合法定界符——終止行是空行，實測），
  // 也可寫成 `<<\EOF`（跳脫＝字面化，定界符是 EOF）。**未加引號的定界符可以含
  // 任意非元字元字元**：/ # $ = : * [ ] . - 都實測合法（`<<EOF/x`、`<<EOF#x`
  // 的終止行就是原字面）。辨識不到就會把本體當指令掃描（＝改到資料），所以
  // 這個字元類要寬。**數字開頭也合法**（`<<2EOF`、`<<-2ND`、`<< 2EOF`、
  // `<<\2X` 實測）——此前第一字限字母/底線，本體被當指令掃描、`cmd //c` 被
  // 改成 `cmd /c`（live 實測：pi bash 工具的本體輸出真的變了）；已比照 oc 修成
  // `\d*[A-Za-z_…]`。第一字仍限「數字/字母/底線」：放寬它會把 `$((x<<$y))`
  // 這類算術位移誤判成 heredoc，`<<*X`／`<<.E`／`<<$S` 與純數字 `<<3` 留在
  // 已知邊界（本體被掃、有機頻率 ~0，見 spec）。反方向也有一個邊界：
  // `$((1<<N))` 的識別字運算元被當 heredoc 開頭 → 換行後整段漏修（安全方向）。
  // （排掉 `)` 與反引號：它們會變成定界符本身的引號語法）
  const heredoc = /<<(-?)[ \t]*(\\?)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\d*[A-Za-z_][^\s"'><;&|()\\`]*))/y; // sticky 已錨定 lastIndex
  const cmdFlag = /\/\/([A-Za-z]+)(?![\w.-])/iy; // cmd 旗標都是字母（/v:on 這類冒號參數自然保留在後）
  // 指令位置不結束的固定集合（bash 語法/內建層，閉集合）——不是「猜哪些程式
  // 會轉發指令」：if/while/{/!/time 是語法關鍵字；exec/command/builtin 是 bash
  // 內建、env 是 POSIX 標準程式，四者後接的第一個詞就是被執行的指令（例外
  // ：exec/command/builtin 後的賦值形會被當指令名跑、原生就錯 → 不暫存，見
  // commitTok；env 的 X= 參數會跨 msys→native 邊界 → 照常暫存）
  //（實測 env/exec/command cmd //c ver 原生跑 ver、本機進互動模式——與裸
  // cmd //c 同一故障；與 oc 版 SHELL_KEYWORDS 對齊）。界線仍在 shell 語法層
  // ：timeout/nice/xargs 這類外部 wrapper 的參數結構才是開放集合（漏修臺見
  // docs/spec.md）
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
  // 記錄（見 docs/spec.md「envp 殘餘形」）。純數字詞（fd 前緣，2>&1 的 2）也不觸發
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
  // 本 token 的內容是否來自「引號詞餵入」（feedTok）：引號詞的內容在 out 裡
  // 帶著前後引號，長度與 curTok 不一致——依它算出的暫存跨度會錯（實測
  // `A=/c/x "B=/c/y" node` 曾被改成 `A=C:/x "BB=C:/y node`＝吃掉收尾引號）。
  // 而且引號詞在 bash 裡本来就不是賦值前綴（quote removal 後才解析指令字）
  // → 不暫存（見 commitTok）。
  let tokQuoted = false;
  // 上一個 token 是否來自引號詞（isCmdTok 的跳脫規則需要它：引號內的反斜線
  // 不被 bash 當跳脫，未引號的才是）
  let prevTokQuoted = false;
  let inBacktick = false; // 反引號開/關（\` 由跳脫分支吃掉，所以是單層）
  const btPos: boolean[] = []; // 每層反引號開頭的「外層是否在指令位置」
  // 括號堆疊：每層 ( 記下 kind ＋「開括號時的外層指令位置」
  //   foo(       → func：函式定義，`)` 之後接 { … } 群組（cmd 仍在指令位置）
  //   $( / $((   → subst：還原開括號時的位置——賦值前綴（count=$(…)）→ true，
  //                bash 真的跑 cmd；獨立替換（$(…)）→ false，替換結果本身就是
  //                指令名、後面的 cmd 只是參數。詞**延續**到括號外（`$(pwd)#z`）
  //   <( / >(   → procsubst：同上還原位置，詞也延續（實測 `echo <(true)#z`）
  //   樣式包裹 ( → case：`)` 是樣式終止符（不是這層的）；不要與外層混淆
  //   群組 ( … ) → group：`( … ) word` 原生就是語法錯誤，`)` 後不開命令位置
  //                （不改寫死文字）；`(true)#c` 的 # 是註解（實測）
  // 單一堆疊（kind 與位置同進同出）——兩張平行陣列會漂移
  const parenStack: { kind: "subst" | "procsubst" | "func" | "group" | "case"; pos: boolean }[] = [];
  // 被 \$ 跳脫分支成對消費的 "$" 位置：該 "$" 是字面——其後的 "(" 不是
  // $( 替換開頭（bash 剖析為語法錯誤），括號分類不得把它當開頭
  const escapedDollar = new Set<number>();
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
  // 最後一個 `)` 收的是什麼決定詞是否延續到括號外：替換／程序替換→延續
  // （`$(pwd)#z`、`<(true)#z` 的 # 是字面資料，實測）；群組／子殼／函式定義
  // 收尾與樣式區的 `)` → 開新詞（`(true)#c`、`a)#c` 的 # 是註解，實測）。
  // 判別依據＝parenStack 的 kind；stack 空（多餘的 `)`＝語法錯誤）→ 維持舊值
  let parenContinuesWord = false;

  // cmd 指令字用 **bash 實際看到的字** 的 basename 比對：
  //   `\cmd`、`c\md`、`/c/Windows/System32/cmd.exe`、`"C:/…/cmd.exe"` 都是同一顆
  //   cmd（實測轉換關閉時全進互動式 banner＝同一個故障）
  // 未引號詞裡的反斜線是 bash 的跳脫字元（`\c` → `c`、`C:\Win…` → `C:Win…`），
  // 所以要比對的是**去跳脫後的詞**：不改的話 `C:\Windows\System32\cmd.exe` 會被
  // basename 命中而改寫，但它原生是 127（不存在的程式名）⇒ 改寫只落在死文字上
  // （文字有變、行為完全一樣＝零效應改寫，实测確認）。反之 `c\md //c` 去跳脫
  // 後就是 `cmd`，是真的會跑的指令——這一條同時把那個漏修變成修復。
  // 引號詞的內容不經跳脫（雙引號内 `\W` 保留反斜線），所以照原樣取 basename。
  // 未引號詞**尾**的反斜線例外：`cmd\\ //c ver` 的成對反斜線先被 bash 縮成一個，
  // 再讓它跳脫後面的分隔符 → bash 看到的程式名是 `cmd\` 而不是 cmd（實測 rc 127
  // 、兩種轉換狀態同訊息）。這種詞不是指令字，不改寫（oc 同守門）；不加這道
  // 判斷就是零效應改寫（文字有變、行為一樣），與本檔的稽核標準衝突。
  const isCmdTok = (t: string, quoted = false) => {
    if (!quoted && /\\$/.test(t)) return false;
    const word = quoted ? t : t.replace(/\\/g, "");
    const base = word.split(/[\\/]/).pop()!.toLowerCase();
    return base === "cmd" || base === "cmd.exe";
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

  const ASSIGN_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
  // 真指令字判定（三個決策點共用：commit 時 staging、真指令字落地時套用、EOF
  // 收尾）：非賦值（含空值 B=）、非語法關鍵字、非內建、非純數字（fd 前緣
  // 2>&1 的 2）。三處各寫一份會漂移（oc 版同一個 predicate）
  const envpTrigger = (t: string) =>
    !ASSIGN_PREFIX.test(t) && !RESERVED_WORD.test(t) && !BUILTIN_WORD.test(t) && !/^\d+$/.test(t);

  const commitTok = () => {
    // 引號詞餵入的來源標記只管到下一個 token 收尾為止：先取再清（下面 `!curTok`
    // 提前返回時也不留殘值——`""` 餵入空內容就是這種形）
    const quotedTok = tokQuoted;
    tokQuoted = false;
    if (!curTok) return;
    prevTokCmdPos = cmdPosNext;
    if (cmdPosNext) {
      // FOO=bar 環境變數前綴、與 if/while/{/! 等語法關鍵字都不結束指令位置
      cmdPosNext = RESERVED_WORD.test(curTok) || ASSIGN_PREFIX.test(curTok);
    }
    // case 區段追蹤（語法見上方註解）：`case` 要在命令位置才算；`in` 在參數位置，
    // 位置 gate 不適用，所以只認「看過 case」（casePending）；`esac` 同 `case` 一樣
    // 只認命令位置——資料位置的 esac（`echo esac`、樣式字面 esac）不能把區段
    // 打掉（實測：`echo esac` 曾把 body 重設成 none，`case $x in esac) …` 的樣式
    // 字面曾被當結束符、造成後續旗標漏修）。
    const lowTok = curTok.toLowerCase();
    if (lowTok === "case" && prevTokCmdPos) casePending = true;
    else if (lowTok === "in" && casePending) { caseRegion = "pattern"; casePending = false; }
    else if (lowTok === "esac" && prevTokCmdPos) { caseRegion = "none"; casePending = false; }
    // 旗標區維持規則：cmd 本身開啟旗標區；區內的 /旗標（含剛改寫的）不關閉；其他 token 關閉
    if (cmdFlagZone && !curTok.startsWith("/")) cmdFlagZone = false;
    if (prevTokCmdPos && isCmdTok(curTok, quotedTok)) cmdFlagZone = true;
    // 前綴賦值路徑改寫的暫存／套用：賦值 token（整詞未引號、值可轉換）在
    // 指令位置 → 暫存；非賦值、非語法關鍵字的 token 在指令位置落地 ＝
    // simple command 的指令字 → 此時暫存賦值確定會進它的 envp，套用。
    // prevTokCmdPos 此時仍是本 token 的位置（commitTok 開頭賦的值）。
    if (prevTokCmdPos) {
      // 賦值判定與 keeper/EOF 一致（含空值 B=）：空值賦值既不暫存（無可轉換
      // 值）也不觸發套用——套用必須是「真指令字」（見 BUILTIN_WORD 註解）。
      // exec/command/builtin 後的賦值形是參數不是前綴（bash 把 X=/c/x 當指令名
      // 跑、原生就大聲失敗——實測三形在兩種轉換狀態下皆 127/127/1 同訊息）：
      // 不暫存、照普通詞結束指令位置（其後的詞都是它的參數，原生命令也不會跑）。
      // env 例外：POSIX 外部程式、X= 參數會跨 msys→native 邊界（實測
      // env X=/c/x node 原生轉換 C:/x）→ 照舊暫存、由後續指令字觸發。
      if (ASSIGN_PREFIX.test(curTok)) {
        if (quotedTok) {
          // 引號詞（`"B=/c/y"`）不是 bash 的賦值前綴：原生把它當指令字跑
          // （實測 `A=/c/x "B=/c/y" node` → bash: B=/c/y: No such file or
          // directory、127）→ 不暫存、照普通詞結束指令位置（不能走下面
          // 的跨度算術：那些跨度假設 curTok 是 out 的字尾，引號詞不是）
          cmdPosNext = false;
        } else if (/^(?:exec|command|builtin)$/.test(prevTok)) {
          cmdPosNext = false;
        } else {
          const em = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(curTok);
          if (em) {
            const conv = convertEnvPath(em[2]!);
            if (conv) pendingEnv.push({ start: out.length - curTok.length, end: out.length, rep: em[1]! + "=" + conv });
          }
        }
      } else if (envpTrigger(curTok)) {
        applyPendingEnv();
      }
    }
    prevTok = curTok;
    prevTokQuoted = quotedTok;
    curTok = "";
  };

  // 双引號內的 $( ) 與 `…` 會真的被 bash 執行（如 R="$(cmd //c ver)"），
  // 必須遞迴掃描；引號本身是字面，但命令取代區域內是完整 shell 語法。
  // 跳脫序成對消費："\$" 的 $ 是字面（其後 "(" 是資料、不是替換開頭——
  // bash 實測 "\$(x)" 印字面 $(x)；改此修之前 "\$( )" 內被當替換掃描改寫＝
  // 靜默誤修 echo 的資料）；"\\" 是字面反斜線、其後的 $( 才是真替換（實測
  // "\\$(pwd)" 印 "\<pwd>"）——成對跳過讓兩側都對。
  const scanDq = (seg: string): string => {
    let s = "";
    let k = 0;
    const m2 = seg.length;
    while (k < m2) {
      const c = seg[k];
      if (c === "\\") {
        s += seg.slice(k, k + 2);
        k += 2;
        continue;
      }
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
      if (command[i + 1] === "$") escapedDollar.add(i + 1); // \$：$ 是字面（見 escapedDollar）
      i += 2;
      continue;
    }
    if (ch === "'") {
      // 引號不改變 word 身分（bash 先做 quote removal 才解析指令字）：獨立成詞
      //（引號前 curTok 為空＝前一詞已結束）且在指令位置時，把去引號內容餵給
      // token——不餵的話下一個詞會以指令位置誤觸套用（A=/c/x "bash" -c …＝靜默
      // 誤修：實測兩種轉換狀態原生皆印 /c/x）。詞中引號（A="…"、ba"sh"）維持
      // 隱形＝舊行為：值的引號是漏修臺的「引號開頭值」形，詞中組合的身分本來
      // 就不可靠，不猜。
      const feedTok = curTok === "" && cmdPosNext;
      commitTok();
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        const seg = command.slice(i);
        out += seg;
        if (feedTok) { curTok += command.slice(i + 1); tokQuoted = true; }
        break;
      }
      const seg = command.slice(i, end + 1);
      out += seg;
      if (feedTok) { curTok += command.slice(i + 1, end); tokQuoted = true; }
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      // 去引號內容餵 token 的規則同單引號分支（見上）；內容含 $()/反引號/跳脫
      // 時不會命中任何閉集合＝與動態詞同類（安全方向）。
      const feedTok = curTok === "" && cmdPosNext;
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
        if (feedTok) { curTok += command.slice(i + 1); tokQuoted = true; }
        break;
      }
      const seg = command.slice(i, j + 1);
      out += scanDq(seg);
      if (feedTok) { curTok += command.slice(i + 1, j); tokQuoted = true; }
      i = j + 1;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      commitTok();
      heredoc.lastIndex = i;
      const m = heredoc.exec(command);
      if (m) {
        pendingDelim = m[3] ?? m[4] ?? m[5]!;
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
        // prev 是未被 \$ 跳脫的 "$" 才算 $( 替換開頭；被跳脫的 $ 後接 "(" 在
        // bash 是語法錯誤（字面 $），照群組括號處理
        // 樣式區裡的 `(`（`case x in (a) …` 的選配包裹）是樣式的一部分，`)` 由
        // 下面的 region 分支當樣式終止符處理（這個堆疊項不是它的括號）
        const prev = command[i - 1] ?? "";
        const kind =
          caseRegion === "pattern"
            ? "case"
            : prev === "$" && !escapedDollar.has(i - 1)
              ? "subst"
              : /[A-Za-z0-9_]/.test(prev)
                ? "func"
                : prev === "<" || prev === ">"
                  ? "procsubst"
                  : "group";
        parenStack.push({ kind, pos: cmdPosNext });
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
          // 樣式終止：沒有自己的 `(`，所以不能 pop 外層堆疊（會偷走 $( 的項）；
          // 只收掉 `case x in (a) …` 那種選配的 "case" 包裹。重開命令位置並
          // 進 body；`)` 後開新詞（`a)#c` 是註解，實測）
          if (parenStack.length && parenStack[parenStack.length - 1]!.kind === "case") parenStack.pop();
          cmdPosNext = true;
          caseRegion = "body";
          parenContinuesWord = false;
        } else {
          // 還原這對括號的結果（stack 空＝多餘的 `)`、語法錯誤，維持現況）：
          //   func/case → 指令位置（函式定義的 body 是命令列表）
          //   subst/procsubst → 開括號時的位置（賦值前綴→true，參數→false）
          //   group → 不開命令位置（`( … ) word` 原生就是語法錯誤，不改死文字）
          const fr = parenStack.pop();
          if (fr !== undefined) cmdPosNext = fr.kind === "func" || fr.kind === "case" ? true : fr.kind === "group" ? false : fr.pos;
          restoreTrue = fr !== undefined && (fr.kind === "func" || (fr.kind === "subst" && fr.pos === true));
          // 詞是否延續到括號外：替換與程序替換收尾＝延續（`$(pwd)#z`、
          // `<(true)#z` 的 # 是字面，實測）；群組／子殼／函式定義收尾開新詞
          // （`(true)#c` 的 # 是註解，實測）。stack 空→維持舊值
          parenContinuesWord = fr === undefined ? true : fr.kind === "subst" || fr.kind === "procsubst";
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
    // cmd 的雙斜線旗標：僅當 cmd 是一個已收尾的詞（curTok 空）且在指令位置。
    // 緊貼形 cmd//c 不改（原先會插一個空格把它拆成「cmd + //c」）：bash 把
    // cmd//c 當程式名，原生是 `bash: cmd//c: No such file or directory`、
    // exit 127——兩種轉換狀態都一樣（實測）。改寫它不是修環境層，而是替模型
    // 改錯字：gate ON 時反而把「大聲 127」變成 banner＋exit 0 的靜默失敗。
    // 同一詞的引號拼法（"cmd"//c）同理不改（實測原生也是 127）
    if (ch === "/" && command[i + 1] === "/") {
      const atCmd =
        curTok === "" &&
        ((prevTokCmdPos && isCmdTok(prevTok, prevTokQuoted)) || (cmdFlagZone && prevTok.startsWith("/")));
      if (atCmd && pathConvDisabled()) {
        cmdFlag.lastIndex = i;
        const m = cmdFlag.exec(command);
        // `//alpha/beta` 是 UNC 形（MSYS 不會轉它，cmd 當它是無效 switch）——
        // 四種組合（原生/本機 × 原形/改寫）實測全是互動 banner ⇒ 改寫零效應，
        // 不做（`cmd //server/share` 就是這種；電池釘樁）。
        if (m && command[i + m[0].length] !== "/") {
          out += "/" + m[1];
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
    // 位置會被當指令字觸發套用）。詞中的 #（a#b）不是註解，照常掃描。
    // 註解內容是死文字、到達不了任何程式——整段照原樣複製到行尾（同 heredoc
    // 本體）。曾把註解內容照一般掃描：註解裡的 `(` 被分類成函式定義、重開
    // 指令位置，`cmd //c ver # note (cmd //x)` 把死文字裡的 //x 也改寫了
    // ＝零效應誤修（每項修復必須指名故障點，死文字沒有）。詞首判準照 bash
    // lexer 的規則——輸入開頭或空白／運算子之後；引號／替換收尾後詞延續
    // （實測 `"a"#b`、`$(pwd)#z` 的 # 是字面），樣式區 `)` 後開新詞（實測
    // `a)#c` 是註解）。行尾的 \n 留給空白分支，讓下一行重開指令語境。
    const atWordHead =
      out === "" ||
      " \t\n;|&(<>".includes(out[out.length - 1]!) ||
      (out.endsWith(")") && !parenContinuesWord);
    if (ch === "#" && curTok === "" && atWordHead) {
      pendingEnv = [];
      let lineEnd = command.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = n;
      out += command.slice(i, lineEnd);
      i = lineEnd;
      continue;
    }
    curTok += ch;
    out += ch;
    i++;
  }
  // EOF：檔尾 token 沒有分隔符觸發 commit——真指令字落在檔尾時前綴賦值一樣
  // 要套用（A=/c/x cmd 的 cmd 就是這種）。賦值（含空值）、語法關鍵字、
  // 內建、純數字詞＝收尾 standalone → 丟棄；參數位置照舊不套用。
  if (curTok && cmdPosNext && envpTrigger(curTok)) {
    applyPendingEnv();
  }
  return { command: out, cmdFlagFixed, envPathFixed };
}

// ===== 使用統計 =====
// 量測外掛實際命中率：分母 toolCalls[tool]＝gate 之後的工具呼叫次數（統計
// 範圍＝實際作用的範圍）；分子 fixes[key]＝真改寫次數，**以故障點（機制）
// 為 key，同一機制的 variant 才合併**：
//   path.tempMount   /tmp 這種 MSYS 掛載路徑（host 不套 MSYS 映射）
//   path.tempVar     $TEMP／%TEMP% 這種變數（host 不展開）
//   shell.cmdFlag    msys argv 旗標轉換被關 → //c|//k 原樣抵達（//c、//k、
//                    多旗標、引號名、basename 路徑全算同一種）
//   shell.envPath    msys envp 賦值值轉換被關（碟符值與 /tmp 值同一個機制）
// 舊版的 path.temp 是兩個 temp 故障合在一起，已拆開（舊檔資料保留不動）。
// pi 沒有 per-extension 儲存 API
//（docs/extensions.md State 段）→ 用官方匯出的 getAgentDir()/
// env-guard-stats.json（吃 PI_CODING_AGENT_DIR 覆蓋），不自己復刻路徑邏輯。
// 分類學、儲存與寫入時機的完整設計（oc 共用）：docs/spec.md〈使用統計〉。

const STATS_FILE = "env-guard-stats.json";

interface Stats {
  schema: 1;
  since: string;
  toolCalls: Record<string, number>;
  fixes: Record<string, number>;
}

let stats: Stats | null = null;
// 載入時的基準快照：persistStats 用「現値−基準」計算本 session 的增量，
// 與磁碟上的最新値合併（並發 sessions 各自 from-load 累加，後寫覆蓋先寫
// 會吃掉對方的增量）
let statsBase: { toolCalls: Record<string, number>; fixes: Record<string, number> } | null = null;
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
        statsBase = { toolCalls: { ...stats.toolCalls }, fixes: { ...stats.fixes } };
        return;
      }
    } catch {
      /* 不存在/讀不了/壞檔：重新開始 */
    }
  }
  stats = { schema: 1, since: new Date().toISOString(), toolCalls: {}, fixes: {} };
  statsBase = { toolCalls: {}, fixes: {} };
}

function persistStats(): void {
  const file = statsFile();
  if (!file || !stats) return;
  try {
    // 寫前重讀合併：把本 session 的增量（現値−載入基準）疊到檔上最新値，合併
    // 結果同時成為新的記憶體値與基準（後續增量從此起算，重複 flush 不會雙計
    // ）。採增量疊加而非 max：max 在鍵級會吞掉單側增量。計數僅 advisory，讀
    // 不了/壞檔 → 照舊直寫現値。
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Stats>;
      if (saved && typeof saved === "object" && saved.schema === 1) {
        const merge = (cur: Record<string, number>, base: Record<string, number>, disk: Record<string, number>) => {
          const out: Record<string, number> = {};
          for (const k of new Set([...Object.keys(cur), ...Object.keys(disk)])) {
            const delta = (cur[k] ?? 0) - (base[k] ?? 0);
            out[k] = (disk[k] ?? 0) + Math.max(delta, 0);
          }
          return out;
        };
        stats.toolCalls = merge(stats.toolCalls, statsBase?.toolCalls ?? {}, adoptCounts(saved.toolCalls));
        stats.fixes = merge(stats.fixes, statsBase?.fixes ?? {}, adoptCounts(saved.fixes));
        statsBase = { toolCalls: { ...stats.toolCalls }, fixes: { ...stats.fixes } };
      }
    } catch { /* 檔不存在（首次）或讀不了：直寫現値 */ }
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
  // 探測對象＝pi 自己配置的 shell（settings.shellPath）交給 getShellConfig 解
  // 析（與 pi spawn bash 的決策同一個呼叫），這樣就不必「假設」pi 會 spawn 哪顆
  // bash。
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

    // 宿主能力缺失（見 hostGap）：默默 inert 看不出原因 → 第一次呼叫告知一次。
    // 先跑一次探測（単次快取）讓第一次呼叫就能判斷，而不是拖到第二次
    if (!hostGapNotified) {
      pathConvDisabled();
      if (hostGap) {
        hostGapNotified = true;
        notifyUI(ctx, `env-guard: disabled — ${hostGap}`, "warning");
      } else {
        hostGapNotified = true; // 能力正常：不必再檢查
      }
    }

    // write / edit / read / grep / find / ls：改寫 path 參數
    //（grep/find/ls 同樣是 host 端解析（resolveToCwd），/tmp/$TEMP 也會出事，
    //  但它們是唯讀工具，失敗型態是「找不到目錄」大聲報錯——修掉是純獲益）
    if (name === "write" || name === "edit" || name === "read" || name === "grep" || name === "find" || name === "ls") {
      bumpTool(name);
      const input = event.input as { path?: string };
      if (typeof input?.path === "string") {
        const fix = rewritePathFix(input.path);
        if (fix.value !== input.path) {
          const from = input.path;
          input.path = fix.value;
          // kind 與值同源（rewritePathFix 只在 splitTempPath 命中時改值）——萬一
          // 以後新增了不屬於 temp 族的改寫，會落在 path.other，不會混進別人的鍵
          bumpFix(fix.kind ?? "path.other");
          notifyUI(
            ctx,
            `env-guard: path rewritten ${from} -> ${fix.value}`,
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
