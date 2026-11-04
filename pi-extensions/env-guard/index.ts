// env-guard — conservative Windows safeguards for pi.
// 1. File-tool temp paths are rewritten to the real MSYS /tmp mount.
// 2. Successful cmd interactive banners are detected after execution and receive an advisory.
// 3. With MSYS path conversion disabled, system instructions advise Windows-form env paths
//    and single-slash native executable flags. Native execution has priority: uncertain inputs
//    are left alone. The input-side bash lexer was an open set: false fixes silently broke
//    valid syntax. Output-side false positives add only an advisory and cannot alter execution.

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

export function setConfiguredShell(fn: () => string | undefined): void {
  configuredShell = fn;
}

function probeShell(): string | null {
  if (probeShellCache !== undefined) return probeShellCache;
  probeShellCache = null;
  if (typeof getShellConfig !== "function") {
    // 舊 pi（< 0.48.0）沒這個 export：探測對象不可得＝不改寫（寧可漏修）
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


const CMD_HINT_MARKER = "[env-guard]";
const SYSTEM_HINT_MARKER = "[env-guard:windows-paths]";

export function pickCmdHint(noConv: boolean): string {
  return noConv
    ? `${CMD_HINT_MARKER} cmd entered interactive mode; the intended command never ran. Exit 0 is not success. In this environment, use cmd /c <command>.`
    : `${CMD_HINT_MARKER} cmd entered interactive mode; the intended command never ran. Exit 0 is not success. In this environment, use cmd //c <command>.`;
}

// cmd 互動模式 banner 的輸出指紋（判別特徵以本機實抓位元組釘樁，spawn 形狀＝
// pi 的 stdio 全管線；stdin=/dev/null 形態另抓）：
//   病理形（NO_PATHCONV 下 `cmd //c …`／`//k`／裸 cmd）：首非空行
//     "Microsoft Windows [版本 …]"（GBK 亂碼，但 ASCII 前綴存活）、第二非空行
//     "(c) Microsoft Corporation…"（所有語系此行 ASCII 前綴存活）、提示符行
//     `X:\…>` 有時在（管線 stdin）、有時不在（/dev/null stdin）——指紋只認
//     前兩行，不認提示符。
//   無害形 `cmd /c ver`（NO_PATHCONV 下正常執行）：輸出只有版本一行 → 不命中。
//   轉換開啟的機器 `cmd //c ver`：//c 被轉換層削成 /c → 同上單行 → 不命中。
//   （banner 永遠兩行成對出現：版本行＋版權行；單獨的版本行是 ver 的正常輸出。）
// 命中只附加 advisory＝零破壞；誤判代價＝多一段文字，不會改壞任何東西。
export function detectCmdBanner(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.length >= 2 && lines[0]!.startsWith("Microsoft Windows [") && lines[1]!.startsWith("(c) Microsoft");
}

function resultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((x) => x && typeof x === "object" && (x as any).type === "text" && typeof (x as any).text === "string").map((x) => (x as any).text as string);
  return texts.length ? texts.join("\n") : null;
}

// ===== 使用統計 =====
// 量測外掛實際命中率：分母 toolCalls[tool]＝gate 之後的工具呼叫次數（統計
// 範圍＝實際作用的範圍）；分子 fixes[key]＝真改寫次數，**以故障點（機制）
// 為 key，同一機制的 variant 才合併**：
//   path.tempMount   /tmp 這種 MSYS 掛載路徑（host 不套 MSYS 映射）
//   path.tempVar     $TEMP／%TEMP% 這種變數（host 不展開）
//   shell.cmdBanner  successful cmd interactive-mode banner detected after execution
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
    // 無論走哪條路徑（合併或首寫／壞檔直寫）寫完就把基準 re-base 到剛落盤的值：
    // 只有合併分支更新基準的話，**首寫**（檔案不存在／讀不了）之後的下一次 flush
    // 會把同一批增量再疊一次（實測：新檔案 + 一個 cmdFlag + shutdown → 記成 2）。
    // 合併分支已經設過同樣的值，這裡重設是幂等的。
    statsBase = { toolCalls: { ...stats.toolCalls }, fixes: { ...stats.fixes } };
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


export default function (pi: ExtensionAPI) {
  if (process.platform !== "win32") return;
  setConfiguredShell(() => {
    try { const s = pi.getSettings?.(); return typeof s?.shellPath === "string" && s.shellPath ? s.shellPath : undefined; }
    catch { return undefined; }
  });
  pi.on("session_shutdown", () => flushStats());
  pi.on("before_agent_start", (event: any) => {
    if (!pathConvDisabled()) return;
    const hint =
      "env-guard (Windows): write prefix-assignment path values in Windows form (VAR=C:/x - VAR=/c/x silently resolves to C:/c/x in native executables). Use single-slash flags for native executables (cmd /c, taskkill /IM).";
    // 文件建議的通道：原地改 systemPromptOptions.promptGuidelines（集合可變；
    // Pi 對 prompt 區段做 diff、只把變更以一則系統訊息補進對話＝快取友善）。
    // 每個 run 重建 options → 每次 run 注入一條，不會跨 run 累積；marker 只防
    // 同一 run 內鏈上 handlers 的重複。
    const guidelines = event.systemPromptOptions?.promptGuidelines;
    if (Array.isArray(guidelines)) {
      if (!guidelines.some((g: unknown) => typeof g === "string" && g.includes(SYSTEM_HINT_MARKER))) {
        guidelines.push(`${SYSTEM_HINT_MARKER} ${hint}`);
      }
      return;
    }
    // 舊宿主沒有 structured options：退回回傳 patch（文件：回傳 systemPrompt
    // 取代本 run 的完整提示）。原地改 event.systemPrompt 不在文件的 in-place
    // 變異清單裡 → 必須回傳。
    const prompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
    if (prompt.includes(SYSTEM_HINT_MARKER)) return;
    return { systemPrompt: prompt ? `${prompt}\n${SYSTEM_HINT_MARKER} ${hint}` : `${SYSTEM_HINT_MARKER} ${hint}` };
  });
  pi.on("tool_call", (event: any) => {
    const name = event.toolName;
    // bash 也計入分母：shell.cmdBanner 的命中率需要它（舊版行為，1900+ 筆歷史
    // 連續性依賴同一口徑）；bash 指令本體不改寫，只計數。
    if (name === "bash") { bumpTool("bash"); return; }
    if (!["write", "edit", "read", "grep", "find", "ls"].includes(name)) return;
    bumpTool(name);
    const input = event.input as { path?: string } | undefined;
    if (typeof input?.path === "string") {
      const fix = rewritePathFix(input.path);
      if (fix.value !== input.path) { input.path = fix.value; bumpFix(fix.kind ?? "path.other"); }
    }
  });
  pi.on("tool_result", (event: any) => {
    if (event.toolName !== "bash") return;
    const result = event.result ?? event;
    if (result.isError === true || (result.structuredContent?.exit_code ?? 0) !== 0) return;
    const text = resultText(result.content);
    if (text === null || !detectCmdBanner(text)) return;
    const advisory = { type: "text", text: pickCmdHint(pathConvDisabled()) };
    // tool_result 的傳播機制是回傳 patch（middleware 鏈，文件明載；原地改
    // content 不在 in-place 變異清單裡）。structuredContent 要原樣帶回——
    // 文件語意：回傳 content 補丁而不回傳 structuredContent 會把後者丟棄。
    const content = Array.isArray(result.content)
      ? [...result.content, advisory]
      : [{ type: "text", text: String(result.content ?? "") }, advisory];
    bumpFix("shell.cmdBanner");
    return { content, structuredContent: result.structuredContent };
  });
}
