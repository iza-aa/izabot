// SPDX-License-Identifier: MIT
// Autonomous ReAct Tool-Calling Adapter for OpenDots (OMP + Perception Eye + Background CUA)

import { spawn } from 'node:child_process';
import type { Context } from 'hono';
import { streamText } from 'hono/streaming';
import {
  cuaClick,
  cuaClickElementOrCoords,
  cuaTypeText,
  cuaPressKey,
  cuaHotkey,
  cuaGetWindowState,
  perceptionObserveWorkspace,
  cuaGroundAndClick,
  getConnectedWindows,
  ensureWindowSnapshot,
  cuaNavigateBrowserBackground,
  bcuCall,
  resolveBcuWindowId,
  resolveBcuWindowMeta,
  syncCursorFromBcuResponse,
} from './desktop-tools.js';
import {
  getActiveSurface,
  setActiveSurface,
  detectSurfaceKind,
  bumpFrameVersion,
  setCursorAction,
  getCursorAction,
  type ActiveSurface,
} from './active-surface.js';
import {
  loadAppMemory,
  formatCompactMemoryForPrompt,
  detectCurrentAppState,
  checkSafetyGate,
  recordReflexionLesson,
  classifyHGamZone,
  evaluateHGamWorkspaceState,
  type HGamZone,
  type ObservedSpatialNode,
  type HGamRuntimeEvaluation,
} from './app-memory.js';
import { AgentSwarmOrchestrator } from './agent-swarm-orchestrator.js';
import type {
  AgentHandoffEnvelope,
  AgentRoleDefinition,
  AgentSpecialization,
  HandoffResult,
  SwarmProgressEvent,
} from './swarm-types.js';
import {
  approveJitApproval,
  createJitApproval,
  denyJitApproval,
  listJitApprovals,
  reviewJitApproval,
  type JitApprovalContext,
} from './jit-approvals.js';
import type { WorkspaceStore } from './workspace.js';
import type { Dot } from '../shared/types.js';

const MAX_REACT_STEPS = 8;
const MAX_DELEGATION_DEPTH = 1;
const DELEGATE_TIMEOUT_MS = 35_000;
const SUB_AGENT_MAX_STEPS = 4;
const SUB_AGENT_STEP_TIMEOUT_MS = 20_000;
const JIT_PREVIEW_CHARS = 600;

interface ReActToolCall {
  thought?: string;
  tool:
    | 'bcu_observe'
    | 'bcu_click'
    | 'bcu_type_text'
    | 'bcu_press_key'
    | 'bcu_scroll'
    | 'bcu_set_value'
    | 'bcu_perform_secondary_action'
    | 'observe_workspace'
    | 'click_workspace'
    | 'type_in_workspace'
    | 'press_key_in_workspace'
    | 'navigate_browser'
    | 'act_pause'
    | 'delegate_to_dot'
    | 'jit_synthesize_and_run'
    | 'final_answer';
  args?: Record<string, unknown>;
  answer?: string;
}

export interface JitApprovalSummary {
  id: string;
  goal: string;
  codePreview: string;
}

export interface OmpRuntimeContext {
  workspace?: WorkspaceStore;
  currentDot?: Dot;
  spaceId?: string;
  threadId: string;
  delegationDepth: number;
  maxDelegationDepth: number;
  collaborators: Dot[];
  activeSurface: ActiveSurface | null;
  progressEvents: string[];
  onProgress?: (message: string) => void;
  jitEnabled: boolean;
  jitApprovals: JitApprovalSummary[];
}

interface OmpReActResult {
  finalReply: string;
  logs: ExecutionLogEntry[];
  paused: boolean;
  timedOut: boolean;
}

interface OmpSandboxOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecutionLogEntry {
  step: number;
  thought?: string;
  tool: string;
  args?: Record<string, unknown>;
  observation?: string;
  timestamp: number;
}

let latestExecutionLogs: ExecutionLogEntry[] = [];

export interface TakeoverState {
  active: boolean;
  reason?: string;
  app_name?: string;
  window_id?: number;
  expected_state?: string;
  timestamp: number;
}

let currentTakeoverState: TakeoverState = {
  active: false,
  timestamp: 0,
};

export function getTakeoverState(): TakeoverState {
  return currentTakeoverState;
}

export function setTakeoverState(state: Partial<TakeoverState>): void {
  currentTakeoverState = {
    ...currentTakeoverState,
    ...state,
    timestamp: Date.now(),
  };
}

export function getLatestExecutionLogs(): ExecutionLogEntry[] {
  return latestExecutionLogs;
}

interface CachedNodeBound {
  centerX: number;
  centerY: number;
  normX: number;
  normY: number;
  label: string;
  role: string;
  zone: HGamZone;
  matchedAnchorId?: string;
}

const bcuNodeBoundsCache = new Map<number, CachedNodeBound>();
let latestHGamEvaluation: HGamRuntimeEvaluation | null = null;

function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface BoundSurfaceResult {
  surface: ActiveSurface | null;
  mismatchReason?: string;
}

/**
 * Resolves the target surface strictly avoiding blind app drift (e.g. falling back to Safari on Netflix when user asks for WhatsApp).
 */
async function resolveBoundSurface(userPrompt?: string): Promise<BoundSurfaceResult> {
  const promptLower = (userPrompt ?? '').toLowerCase();
  const windows = await getConnectedWindows();

  const knownTargets = [
    { key: 'whatsapp', match: 'whatsapp', display: 'WhatsApp' },
    { key: 'safari', match: 'safari', display: 'Safari' },
    { key: 'chrome', match: 'chrome', display: 'Google Chrome' },
    { key: 'telegram', match: 'telegram', display: 'Telegram' },
    { key: 'slack', match: 'slack', display: 'Slack' },
    { key: 'spotify', match: 'spotify', display: 'Spotify' },
  ];

  let matchedTarget = knownTargets.find((t) => promptLower.includes(t.key));

  // 2. Semantic URL / Web intent matching (e.g. "buka google.com", "buka youtube", "cari di web")
  if (!matchedTarget) {
    const isWebIntent =
      promptLower.includes('google') ||
      promptLower.includes('youtube') ||
      promptLower.includes('.com') ||
      promptLower.includes('.org') ||
      promptLower.includes('.id') ||
      promptLower.includes('.net') ||
      promptLower.includes('http://') ||
      promptLower.includes('https://') ||
      promptLower.includes('browsing') ||
      promptLower.includes('web');

    if (isWebIntent) {
      const browser = windows.find((w) =>
        ['safari', 'chrome', 'brave', 'arc', 'edge'].some((b) =>
          w.app_name.toLowerCase().includes(b),
        ),
      );
      if (browser) {
        matchedTarget = {
          key: browser.app_name.toLowerCase(),
          match: browser.app_name.toLowerCase(),
          display: browser.app_name,
        };
      } else {
        return {
          surface: null,
          mismatchReason:
            'Tidak ada aplikasi browser (Safari atau Google Chrome) yang terbuka di Mac Anda. Silakan buka browser terlebih dahulu (biarkan di belakang OpenDots).',
        };
      }
    }
  }

  // 3. Semantic Chat / Messaging intent matching (e.g. "buka chat iweng", "kirim wa", "chat budi")
  if (!matchedTarget) {
    const isChatIntent =
      promptLower.includes('chat') ||
      promptLower.includes('wa ') ||
      promptLower.includes('whatsapp') ||
      promptLower.includes('pesan');

    if (isChatIntent) {
      const wa = windows.find((w) => w.app_name.toLowerCase().includes('whatsapp'));
      if (wa) {
        matchedTarget = {
          key: 'whatsapp',
          match: 'whatsapp',
          display: 'WhatsApp',
        };
      } else {
        return {
          surface: null,
          mismatchReason:
            'Aplikasi WhatsApp belum terbuka di Mac Anda. Silakan buka WhatsApp terlebih dahulu (biarkan di belakang OpenDots).',
        };
      }
    }
  }

  if (matchedTarget) {
    const found = windows.find((w) => w.app_name.toLowerCase().includes(matchedTarget.match));
    if (found) {
      const surface: ActiveSurface = {
        window_id: found.window_id,
        pid: found.pid,
        app_name: found.app_name,
        surface_kind: detectSurfaceKind(found.app_name),
        title: found.title,
        width: found.width,
        height: found.height,
        updated_at: Date.now(),
        frame_version: bumpFrameVersion(found.window_id),
      };
      setActiveSurface(surface);
      return { surface };
    }
    return {
      surface: null,
      mismatchReason: `Aplikasi ${matchedTarget.display} belum terbuka atau jendelanya sedang di-minimize di macOS. Silakan buka ${matchedTarget.display} (biarkan di belakang OpenDots) dan pilih di kanvas Workspace.`,
    };
  }

  const existing = getActiveSurface();
  if (existing) {
    const liveMatch = windows.find((w) => w.window_id === existing.window_id);
    if (liveMatch) {
      if (liveMatch.pid && liveMatch.pid !== existing.pid) {
        existing.pid = liveMatch.pid;
        setActiveSurface(existing);
      }
      return { surface: existing };
    }
  }

  if (windows.length > 0) {
    const first = windows[0]!;
    const initialized: ActiveSurface = {
      window_id: first.window_id,
      pid: first.pid,
      app_name: first.app_name,
      surface_kind: detectSurfaceKind(first.app_name),
      title: first.title,
      width: first.width,
      height: first.height,
      updated_at: Date.now(),
      frame_version: 1,
    };
    setActiveSurface(initialized);
    return { surface: initialized };
  }

  return { surface: null };
}

export function buildReActSystemPrompt(
  surface: ActiveSurface | null,
  userPrompt = '',
  runtimeEval: HGamRuntimeEvaluation | null = null,
  runtime?: OmpRuntimeContext,
): string {
  let memoryContext = '';
  if (surface) {
    const memory = loadAppMemory(surface.app_name);
    if (memory) {
      memoryContext = formatCompactMemoryForPrompt(
        memory,
        runtimeEval?.stateId ?? 'chat_list_idle',
        userPrompt,
        runtimeEval,
      );
    }
  }
  const surfaceContext = surface
    ? [
        `ACTIVE WORKSPACE SURFACE (STRICT SANDBOX):`,
        `- Bound Application: "${surface.app_name}"`,
        `- Surface Kind: ${surface.surface_kind}`,
        `- Window Title: "${surface.title}"`,
        `- Window ID: ${surface.window_id} | PID: ${surface.pid}`,
        `- Logical Dimensions: ${surface.width} x ${surface.height} points (Origin 0,0 is TOP-LEFT)`,
        ``,
        `- Anda HANYA diizinkan mengamati dan mengendalikan aplikasi "${surface.app_name}" yang sedang terikat di atas.`,
        `- Jika pengguna meminta membuka, menjalankan, atau mengirim pesan ke aplikasi LAIN di luar "${surface.app_name}" (misalnya meminta membuka Safari, Chrome, Telegram, Calculator saat workspace terikat ke "${surface.app_name}"), JANGAN panggil tool aksi. Langsung gunakan tool "final_answer" untuk menolak secara sopan dan minta pengguna mengganti aplikasi aktif di dropdown panel kanan terlebih dahulu.`,
        ``,
        `STATUS SISTEM & IZIN MACOS:`,
        `- Seluruh izin Aksesibilitas dan Screen Recording telah DIIZINKAN dan AKTIF di macOS.`,
        `- Dilarang menolak instruksi atau berasumsi bahwa izin Aksesibilitas tidak tersedia. Seluruh tool siap digunakan.`,
      ].join('\n')
    : [
        `ACTIVE WORKSPACE SURFACE: Tidak ada jendela aplikasi yang terdeteksi.`,
        `- Beritahu pengguna secara ramah bahwa belum ada jendela aplikasi yang terikat di panel workspace kanan.`,
      ].join('\n');

  const dotContext = runtime?.currentDot
    ? [
        `DOT AKTIF: "${runtime.currentDot.name}" (${runtime.currentDot.id})`,
        `INSTRUKSI DOT: ${runtime.currentDot.instructions || 'Tidak ada instruksi khusus.'}`,
      ].join('\n')
    : '';
  const canDelegate = Boolean(
    runtime &&
      runtime.delegationDepth < runtime.maxDelegationDepth &&
      runtime.collaborators.length > 0,
  );
  const delegationContext = canDelegate
    ? [
        `DELEGASI DOT: Anda boleh mendelegasikan subtugas kepada Dot lain di Space yang sama.`,
        `Gunakan tool "delegate_to_dot" hanya jika subtugas benar-benar lebih cocok dikerjakan Dot lain.`,
        `Dot yang tersedia:`,
        ...runtime!.collaborators.map(
          (dot) =>
            `- id: ${dot.id} | nama: ${dot.name} | instruksi: ${dot.instructions.slice(0, 240)}`,
        ),
      ].join('\n')
    : runtime && runtime.delegationDepth >= runtime.maxDelegationDepth
      ? `DELEGASI DOT: Dinonaktifkan untuk sesi ini (delegationDepth=${runtime.delegationDepth}). Selesaikan tugas sendiri; jangan memanggil delegate_to_dot.`
      : '';
  const canUseJit = Boolean(
    runtime?.jitEnabled &&
      runtime.delegationDepth === 0 &&
      runtime.currentDot &&
      runtime.spaceId,
  );
  const jitContext = canUseJit
    ? [
        `JIT SCRIPT: Anda dapat memakai "jit_synthesize_and_run" untuk tugas deterministik yang lebih aman diselesaikan dengan skrip (transformasi data, HTTP/JSON, parsing file).`,
        `Tool ini TIDAK langsung menjalankan kode. Tool hanya membuat permintaan persetujuan; owner harus menjalankan "/jit-review <id>" lalu "/jit-approve <id>".`,
        `Jangan pernah memasukkan secret, token, atau password ke dalam kode. Jika tool mengembalikan status approval_required, berhenti dan beritahu owner ID persetujuannya; jangan mengulang skrip yang sama.`,
      ].join('\n')
    : runtime && runtime.delegationDepth > 0
      ? `JIT SCRIPT: Dinonaktifkan untuk sub-agen. Jangan memanggil jit_synthesize_and_run.`
      : '';

  return [
    `OPEN_DOTS: TRUE AUTONOMOUS REACT TOOL-CALLING AGENT SPECIFICATION`,
    `INSTRUKSI MUTLAK UNTUK AI CODING AGENT:`,
    `Dokumen ini adalah panduan implementasi teknis untuk bertindak sebagai ReAct (Reasoning + Acting) Agent otonom sejati di dalam panel kanan OpenDots.`,
    `Dilarang keras menggunakan kata kunci rekayasa regex. Model AI langsung diberikan instrumen tool resmi (observe_workspace, click_workspace, type_in_workspace, press_key_in_workspace, navigate_browser, final_answer${canDelegate ? ', delegate_to_dot' : ''}${canUseJit ? ', dan jit_synthesize_and_run' : ''}).`,
    `Dilarang menggunakan karakter emoji dalam pemikiran maupun jawaban akhir.`,
    ``,
    surfaceContext,
    '',
    dotContext,
    '',
    delegationContext,
    '',
    jitContext,
    '',
    memoryContext,
    '',
    `DAFTAR INSTRUMEN TOOL YANG TERSEDIA:`,
    `1. "bcu_observe": Mengamati jendela "${surface?.app_name ?? 'aktif'}" di background. Mengembalikan screenshot terbaru (dengan kursor terkomposit) dan daftar elemen UI Accessibility dengan "display_index", "role", "label", "title", "bounds".`,
    `   Args: { "maxNodes"?: number }`,
    `2. "bcu_click": Mengeklik elemen UI di dalam jendela "${surface?.app_name ?? 'aktif'}" secara background.`,
    `   Args: { "target"?: { "kind": "display_index", "value": number }, "x"?: number, "y"?: number, "clickCount"?: 1 | 2 }`,
    `   Anjuran Mutlak: Jika dari bcu_observe elemen memiliki "display_index", gunakan "target": {"kind": "display_index", "value": <N>} karena paling andal menembus background di macOS.`,
    `3. "bcu_type_text": Mengetikkan teks ke dalam elemen yang sedang fokus atau kolom input di "${surface?.app_name ?? 'aktif'}" secara background.`,
    `   Args: { "text": string, "focusAssistMode"?: "focus_and_caret_end" }`,
    `4. "bcu_press_key": Menekan tombol keyboard atau shortcut di dalam "${surface?.app_name ?? 'aktif'}" secara background.`,
    `   Args: { "key": string } (contoh: "Return", "Escape", "Tab", "Backspace", "Command+f")`,
    `5. "bcu_scroll": Menggulung daftar chat atau halaman di dalam "${surface?.app_name ?? 'aktif'}" secara background.`,
    `   Args: { "target"?: { "kind": "display_index", "value": number }, "deltaX"?: number, "deltaY"?: number }`,
    `6. "bcu_set_value": Mengisi nilai input field secara langsung tanpa mengetik huruf demi huruf.`,
    `   Args: { "target": { "kind": "display_index", "value": number }, "value": string }`,
    `7. "bcu_perform_secondary_action": Menjalankan aksi sekunder pada elemen (misal klik kanan context menu).`,
    `   Args: { "target": { "kind": "display_index", "value": number }, "action": string }`,
    `8. "navigate_browser": Membuka atau menavigasikan URL di dalam browser "${surface?.app_name ?? 'aktif'}" (hanya jika jenis aplikasi adalah browser).`,
    `   Args: { "url": string } (contoh: { "url": "google.com" } atau { "url": "https://google.com" }).`,
    `9. "act_pause": Menghentikan sementara otomasi background dan menyerahkan kendali kepada pengguna manusia (Human Takeover) jika diperlukan tindakan sensitif, persetujuan pengguna, atau verifikasi manual (misal: PIN sandi, 2FA OTP, konfirmasi transaksi, verifikasi CAPTCHA, atau panggilan telepon).`,
    `   Args: { "reason": string, "expected_state"?: string }`,
    `10. "final_answer": Mengakhiri siklus ReAct dan memberikan jawaban akhir yang ramah, jujur, dan jelas kepada pengguna.`,
    `   Args: {} (isi field "answer" pada level root JSON).`,
    ...(canDelegate
      ? [
          `11. "delegate_to_dot": Mendelegasikan subtugas yang spesifik dan mandiri kepada Dot lain di Space yang sama.`,
          `   Args: { "dot_id"?: string, "name"?: string, "objective": string, "context"?: string }`,
          `   Gunakan "dot_id" dari daftar Dot yang tersedia. Jangan mendelegasikan seluruh tugas utama; berikan objective yang jelas dan dapat diselesaikan sendiri oleh Dot tujuan.`,
        ]
      : []),
    ...(canUseJit
      ? [
          `12. "jit_synthesize_and_run": Mengusulkan skrip JavaScript (.mjs) untuk tugas deterministik. Tool ini membuat approval request dan TIDAK menjalankan kode sampai owner menyetujui.`,
          `   Args: { "goal": string, "code": string, "args"?: object }`,
          `   Kode harus membaca argumen dari process.argv[2] sebagai JSON dan mencetak SATU baris JSON ke stdout. Jangan memakai secret. Jika hasilnya approval_required, laporkan approval_id dan berhenti.`,
        ]
      : []),
    ``,
    `ATURAN PENALARAN REACT (Autonomous Observe-Think-Act-Verify Loop):`,
    `- Anda adalah Autonomous Agent yang berpikir mandiri tanpa ada aturan regex hardcoded.`,
    `- Siklus penalaran Anda terdiri dari beberapa tahap:`,
    `  Tahap 1 (Observe): Panggil "bcu_observe" untuk melihat keadaan jendela saat ini dan membaca elemen UI yang ada.`,
    `  Tahap 2 (Reasoning & Act): Buat penalaran (Thought) mengenai apa yang perlu dilakukan berdasarkan elemen yang Anda lihat, lalu panggil aksi (misal: "bcu_type_text", "bcu_click", atau "bcu_press_key").`,
    `  Tahap 3 (Verify): Panggil kembali "bcu_observe" untuk memverifikasi apakah tindakan Anda berhasil mengubah tampilan layar sesuai harapan.`,
    `  Tahap 4 (Loop): Ulangi tindakan jika diperlukan sampai tugas benar-benar selesai.`,
    `  Tahap 5 (Complete): Panggil "final_answer" untuk melaporkan hasil akhir yang sebenarnya kepada pengguna.`,
    `- Dilarang membuat kesimpulan palsu. Jika elemen target tidak ditemukan di layar setelah dicari, laporkan dengan jujur bahwa elemen tidak ditemukan.`,
    ``,
    `TIPS STRUKTUR ANTARMUKA WHATSAPP:`,
    `- Untuk membuka obrolan kontak dari daftar: Pilih elemen di daftar obrolan sebelah kiri (di bawah "List of chats").`,
    `- Jika search bar fokus dan menampilkan filter (Photos, GIFs, Links), Anda dapat menekan "Escape" ("bcu_press_key" dengan {"key": "Escape"}) untuk menutup filter tersebut, atau ketik nama kontak di search bar ("bcu_type_text" dengan {"text": "nama_kontak"}).`,
    `- Kolom input ketik pesan ada di bagian paling bawah jendela.`,
    `FORMAT OUTPUT WAJIB:`,
    `Setiap respons Anda WAJIB berupa 1 objek JSON murni (tanpa penjelasan di luar JSON):`,
    `Jika memanggil tool:`,
    `{"thought": "Alasan singkat langkah ini", "tool": "observe_workspace", "args": {"query": "#dowhatexcites", "provider": "apple_vision"}}`,
    ...(canDelegate
      ? [
          `Jika mendelegasikan:`,
          `{"thought": "Subtask ini lebih cocok untuk Dot lain", "tool": "delegate_to_dot", "args": {"dot_id": "<id>", "objective": "Tugas spesifik yang harus diselesaikan", "context": "Konteks pendukung"}}`,
        ]
      : []),
    ...(canUseJit
      ? [
          `Jika mengusulkan skrip JIT:`,
          `{"thought": "Tugas ini deterministik dan lebih aman memakai skrip", "tool": "jit_synthesize_and_run", "args": {"goal": "Tujuan skrip", "code": "const args = JSON.parse(process.argv[2] || \\"{}\\"); console.log(JSON.stringify({ ok: true, args }));", "args": {}}}`,
        ]
      : []),
    `Jika selesai dan menjawab pengguna:`,
    `{"thought": "Tugas selesai", "tool": "final_answer", "answer": "Penjelasan lengkap kepada pengguna dalam bahasa Indonesia."}`,
  ].join('\n');
}

function parseReActDecision(rawOutput: string): ReActToolCall {
  let cleaned = rawOutput
    .replace(/^```json\s*/im, '')
    .replace(/^```\s*/im, '')
    .replace(/\s*```$/im, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(jsonCandidate) as ReActToolCall;
      if (parsed && typeof parsed.tool === 'string') {
        return parsed;
      }
    } catch {
      // Find valid JSON object block
      const jsonMatches = cleaned.match(/\{[\s\S]*?\}/g);
      if (jsonMatches) {
        for (let i = jsonMatches.length - 1; i >= 0; i--) {
          try {
            const candidate = JSON.parse(jsonMatches[i]!) as ReActToolCall;
            if (candidate && typeof candidate.tool === 'string') {
              return candidate;
            }
          } catch {}
        }
      }
    }
  }

  return {
    thought: 'Direct response fallback',
    tool: 'final_answer',
    answer: rawOutput.trim() || 'Selesai memproses permintaan Anda.',
  };
}

async function executeOmpSandboxed(
  prompt: string,
  options: OmpSandboxOptions = {},
): Promise<string> {
  const { timeoutMs = 60_000, signal } = options;
  if (signal?.aborted) throw new Error('OMP execution aborted.');

  const { promise, resolve, reject } = withResolvers<string>();
  const env = { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/usr/bin` };

  const proc = spawn(
    'omp',
    [
      '-p',
      '--model=gemini-2.5-flash-lite',
      '--no-tools',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--thinking=off',
    ],
    {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  let settled = false;
  const settle = (value: string) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const stopProcess = () => {
    try {
      proc.kill('SIGKILL');
    } catch {}
  };

  proc.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  // A killed OMP process can close stdin before the write completes.
  proc.stdin.on('error', () => {});

  proc.on('close', () => {
    if (stdout.trim().length > 0) {
      settle(stdout.trim());
    } else {
      settle(
        JSON.stringify({
          tool: 'final_answer',
          answer: stderr.trim() || 'OMP selesai memproses giliran.',
        }),
      );
    }
  });

  proc.on('error', (err) => {
    fail(err);
  });

  const onAbort = () => {
    stopProcess();
    fail(new Error('OMP execution aborted.'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  proc.stdin.write(prompt);
  proc.stdin.end();

  const timer = setTimeout(() => {
    stopProcess();
    settle(
      JSON.stringify({
        tool: 'final_answer',
        answer: 'Waktu tunggu penalaran OMP habis. Tindakan telah dihentikan.',
      }),
    );
  }, timeoutMs);

  return promise.finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}

function inferSpecialization(dot: Dot): AgentSpecialization {
  const text = `${dot.name} ${dot.instructions}`.toLowerCase();
  if (/(critic|review|security|audit)/.test(text)) return 'critic_reviewer';
  if (/(research|riset|analyst|investigat)/.test(text)) return 'researcher';
  if (/(code|coding|script|developer|engineer)/.test(text)) return 'coder';
  if (/(troubleshoot|recover|repair|debug)/.test(text)) return 'troubleshooter';
  return 'cua_operator';
}

function buildAgentRole(dot: Dot, boundAppName?: string): AgentRoleDefinition {
  return {
    dotId: dot.id,
    name: dot.name,
    avatarBadge: `[${dot.name}]`,
    specialization: inferSpecialization(dot),
    boundAppName,
    systemInstructions: dot.instructions,
    allowedTools: [
      'observe_workspace',
      'click_workspace',
      'type_in_workspace',
      'press_key_in_workspace',
      'navigate_browser',
      'final_answer',
    ],
    maxContextTokens: 8000,
    timeoutMs: DELEGATE_TIMEOUT_MS,
  };
}

export function resolveDelegationTarget(
  args: Record<string, unknown>,
  runtime: OmpRuntimeContext,
): { target?: Dot; error?: string } {
  if (!runtime.collaborators.length) {
    return {
      error:
        'Tidak ada Dot lain di Space ini. Selesaikan tugas sendiri tanpa delegate_to_dot.',
    };
  }

  const rawId =
    typeof args.dot_id === 'string'
      ? args.dot_id
      : typeof args.dotId === 'string'
        ? args.dotId
        : '';
  const rawName =
    typeof args.name === 'string'
      ? args.name
      : typeof args.dot_name === 'string'
        ? args.dot_name
        : typeof args.dotName === 'string'
          ? args.dotName
          : '';

  const target = rawId
    ? runtime.collaborators.find((dot) => dot.id === rawId)
    : rawName
      ? runtime.collaborators.find(
          (dot) => dot.name.toLowerCase() === rawName.trim().toLowerCase(),
        )
      : runtime.collaborators.length === 1
        ? runtime.collaborators[0]
        : undefined;

  if (!target) {
    return {
      error: `Dot tujuan tidak ditemukan. Pilih salah satu: ${runtime.collaborators
        .map((dot) => `${dot.name} (${dot.id})`)
        .join(', ')}.`,
    };
  }

  return { target };
}

async function handleDelegateToDot(
  args: Record<string, unknown>,
  runtime: OmpRuntimeContext,
): Promise<string> {
  if (!runtime.workspace || !runtime.currentDot || !runtime.spaceId) {
    return JSON.stringify({
      ok: false,
      error:
        'Delegasi tidak tersedia karena konteks workspace/Dot belum terhubung.',
    });
  }
  if (runtime.delegationDepth >= runtime.maxDelegationDepth) {
    return JSON.stringify({
      ok: false,
      error:
        'Delegasi diblokir oleh recursion guard. Selesaikan tugas ini sendiri tanpa mendelegasikan ulang.',
    });
  }

  const objective =
    typeof args.objective === 'string'
      ? args.objective.trim()
      : typeof args.task === 'string'
        ? args.task.trim()
        : '';
  if (!objective) {
    return JSON.stringify({
      ok: false,
      error: 'Parameter objective wajib diisi untuk delegate_to_dot.',
    });
  }
  const contextPayload = args.context;
  const contextText =
    typeof contextPayload === 'string'
      ? contextPayload.slice(0, 4000)
      : contextPayload
        ? JSON.stringify(contextPayload).slice(0, 4000)
        : '';

  const resolved = resolveDelegationTarget(args, runtime);
  if (!resolved.target) {
    return JSON.stringify({ ok: false, error: resolved.error });
  }
  const target = resolved.target;
  const fromRole = buildAgentRole(
    runtime.currentDot,
    runtime.activeSurface?.app_name,
  );
  const targetRole = buildAgentRole(target, runtime.activeSurface?.app_name);
  const orchestrator = new AgentSwarmOrchestrator(
    async (workerRole, envelope, signal) =>
      executeDelegatedTurn(workerRole, envelope, signal, runtime),
  );
  orchestrator.registerRole(fromRole);
  orchestrator.registerRole(targetRole);

  const onProgress = (event: SwarmProgressEvent) => {
    const message = `[${event.status}] ${event.activeDot.name}: ${event.handoverMessage}`;
    if (runtime.progressEvents.length < 50) runtime.progressEvents.push(message);
    try {
      runtime.onProgress?.(message);
    } catch {
      // Progress reporting must never break the delegated task.
    }
  };
  orchestrator.on('swarm:progress', onProgress);

  try {
    const result = await orchestrator.executeDelegation({
      spaceId: runtime.spaceId,
      threadId: runtime.threadId,
      fromDotId: runtime.currentDot.id,
      targetDotId: target.id,
      objective,
      context: {
        success: true,
        executiveSummary: objective,
        structuredPayload: {
          fromDot: runtime.currentDot.name,
          context: contextText,
        },
        artifactPaths: [],
        verificationNotes: [],
        confidenceScore: 1.0,
      },
    });
    return JSON.stringify({
      ok: result.success,
      delegated_to: { id: target.id, name: target.name },
      result,
    });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      delegated_to: { id: target.id, name: target.name },
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    orchestrator.off('swarm:progress', onProgress);
  }
}

async function executeDelegatedTurn(
  role: AgentRoleDefinition,
  envelope: AgentHandoffEnvelope,
  signal: AbortSignal,
  parentRuntime: OmpRuntimeContext,
): Promise<HandoffResult> {
  const targetDot = parentRuntime.workspace?.dot(role.dotId);
  if (!targetDot) throw new Error(`Dot ${role.dotId} tidak ditemukan.`);

  const childRuntime: OmpRuntimeContext = {
    ...parentRuntime,
    currentDot: targetDot,
    delegationDepth: parentRuntime.delegationDepth + 1,
    collaborators: [],
    progressEvents: parentRuntime.progressEvents,
    onProgress: parentRuntime.onProgress,
  };
  const contextText = JSON.stringify(
    envelope.distilledContext.structuredPayload ?? {},
  ).slice(0, 4000);
  const transcript = `Tugas ini didelegasikan oleh "${envelope.fromDotId}" (${envelope.fromRole}).\nKonteks: ${contextText}`;

  const result = await runOmpReAct({
    surface: parentRuntime.activeSurface,
    prompt: envelope.taskObjective,
    transcript,
    runtime: childRuntime,
    maxSteps: SUB_AGENT_MAX_STEPS,
    perStepTimeoutMs: SUB_AGENT_STEP_TIMEOUT_MS,
    signal,
    logSink: [],
    buildSystemPrompt: (runtimeEval) =>
      buildReActSystemPrompt(
        parentRuntime.activeSurface,
        envelope.taskObjective,
        runtimeEval,
        childRuntime,
      ),
  });

  if (result.timedOut) {
    throw new Error(
      `Delegated Dot "${role.name}" timed out after ${DELEGATE_TIMEOUT_MS}ms.`,
    );
  }

  const notes = result.logs
    .slice(-4)
    .map(
      (entry) => `${entry.tool}: ${(entry.observation ?? '').slice(0, 160)}`,
    );
  return {
    success: Boolean(result.finalReply.trim()) && !result.paused,
    executiveSummary: result.finalReply.slice(0, 1200),
    structuredPayload: {
      delegatedTask: envelope.taskObjective,
      finalAnswer: result.finalReply,
    },
    artifactPaths: [],
    verificationNotes: notes,
    confidenceScore: result.paused ? 0.5 : 0.85,
  };
}

function normalizeJitCode(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:js|javascript|mjs)?\s*\n?([\s\S]*?)\n?```$/i.exec(
    trimmed,
  );
  return fenced?.[1]?.trim() ?? trimmed;
}

async function handleJitTool(
  args: Record<string, unknown>,
  runtime: OmpRuntimeContext,
): Promise<string> {
  if (!runtime.jitEnabled) {
    return JSON.stringify({
      ok: false,
      error:
        'JIT execution is disabled by owner policy (IZABOT_ENABLE_JIT=0).',
    });
  }
  if (runtime.delegationDepth > 0) {
    return JSON.stringify({
      ok: false,
      error: 'JIT execution is not available to delegated sub-agents.',
    });
  }
  if (!runtime.currentDot || !runtime.spaceId) {
    return JSON.stringify({
      ok: false,
      error: 'JIT requires an active Dot and Space context.',
    });
  }

  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  const code =
    typeof args.code === 'string' ? normalizeJitCode(args.code) : '';
  if (!goal || !code) {
    return JSON.stringify({
      ok: false,
      error: 'Both goal and code are required for jit_synthesize_and_run.',
    });
  }
  const rawArgs = args.args;
  const argsJson =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  try {
    const approval = createJitApproval({
      threadId: runtime.threadId,
      dotId: runtime.currentDot.id,
      spaceId: runtime.spaceId,
      goal,
      code,
      argsJson,
    });
    const summary: JitApprovalSummary = {
      id: approval.id,
      goal,
      codePreview: code.slice(0, JIT_PREVIEW_CHARS),
    };
    if (runtime.jitApprovals.length < 10) runtime.jitApprovals.push(summary);
    return JSON.stringify({
      ok: false,
      status: 'approval_required',
      approval_id: approval.id,
      goal,
      code_preview: summary.codePreview,
      next_step: `Owner must run "/jit-review ${approval.id}", then "/jit-approve ${approval.id}". The script has NOT run yet.`,
      expires_at: new Date(approval.expiresAt).toISOString(),
    });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeWorkspaceTool(
  call: ReActToolCall,
  surface: ActiveSurface | null,
  userPrompt: string,
  runtime: OmpRuntimeContext,
): Promise<string> {
  if (call.tool === 'delegate_to_dot') {
    return handleDelegateToDot(call.args ?? {}, runtime);
  }
  if (call.tool === 'jit_synthesize_and_run') {
    return handleJitTool(call.args ?? {}, runtime);
  }

  if (!surface) {
    return JSON.stringify({
      ok: false,
      error: 'Tidak ada aplikasi aktif yang terikat di workspace kanan.',
    });
  }

  const { window_id: windowId, pid, width: winWidth, height: winHeight, app_name: appName } = surface;
  const args = call.args ?? {};

  switch (call.tool) {
    case 'bcu_observe':
    case 'observe_workspace': {
      const bcuTarget = (await resolveBcuWindowId(windowId, appName)) ?? String(windowId);
      const res = await bcuCall('/v1/get_window_state', {
        window: bcuTarget,
        imageMode: 'path',
        maxNodes: typeof args.maxNodes === 'number' ? args.maxNodes : 80,
      });

      if (!res.ok) {
        const obs = await perceptionObserveWorkspace({ windowId, provider: 'apple_vision', settleDelayMs: 150 });
        return JSON.stringify({
          ok: false,
          fallback: 'apple_vision',
          elements: obs.elements.slice(0, 30).map((e) => ({
            id: e.id,
            label: e.label,
            center_x: e.center_x,
            center_y: e.center_y,
          })),
        });
      }

      const stateData = (res.data || {}) as Record<string, unknown>;
      const treeObj = stateData.tree as {
        renderedText?: string;
        nodes?: Array<{
          displayIndex?: number;
          role?: string;
          label?: string;
          title?: string;
          frameAppKit?: { x: number; y: number; width: number; height: number };
          suggestedInteractionPointAppKit?: { x: number; y: number };
        }>;
      } | undefined;

      const winObj = (stateData.window || {}) as {
        frameAppKit?: { x: number; y: number; width: number; height: number };
      };
      const winFrame = winObj.frameAppKit;
      const winX = winFrame?.x ?? 0;
      const winY = winFrame?.y ?? 0;
      const winW = winFrame?.width ?? (winWidth || 1512);
      const winH = winFrame?.height ?? (winHeight || 873);

      const rawNodes = treeObj?.nodes ?? [];
      bcuNodeBoundsCache.clear();
      for (const n of rawNodes) {
        if (typeof n.displayIndex === 'number') {
          let cx = Math.round(winW * 0.22);
          let cy = Math.round(winH * 0.28);
          if (n.suggestedInteractionPointAppKit) {
            cx = Math.round(n.suggestedInteractionPointAppKit.x - winX);
            cy = Math.round(Math.max(10, (winY + winH) - n.suggestedInteractionPointAppKit.y));
          } else if (n.frameAppKit) {
            const centerX = n.frameAppKit.x + (n.frameAppKit.width || 20) / 2;
            const centerY = n.frameAppKit.y + (n.frameAppKit.height || 20) / 2;
            cx = Math.round(centerX - winX);
            cy = Math.round(Math.max(10, (winY + winH) - centerY));
          }

          const normX = Math.max(0.01, Math.min(0.99, Number((cx / winW).toFixed(4))));
          const normY = Math.max(0.01, Math.min(0.99, Number((cy / winH).toFixed(4))));

          const zone = classifyHGamZone(normX, normY);

          bcuNodeBoundsCache.set(n.displayIndex, {
            centerX: cx,
            centerY: cy,
            normX,
            normY,
            label: n.label || n.title || n.role || `Elemen #${n.displayIndex}`,
            role: n.role || '',
            zone,
          });
        }
      }

      const memory = loadAppMemory(appName);
      if (memory) {
        const spatialNodes: ObservedSpatialNode[] = Array.from(bcuNodeBoundsCache.entries()).map(
          ([displayIndex, b]) => ({
            displayIndex,
            role: b.role,
            label: b.label,
            normX: b.normX,
            normY: b.normY,
            zone: b.zone,
          }),
        );
        latestHGamEvaluation = evaluateHGamWorkspaceState(memory, spatialNodes, userPrompt);
        for (const sn of spatialNodes) {
          if (sn.displayIndex !== undefined && sn.matchedAnchorId) {
            const cached = bcuNodeBoundsCache.get(sn.displayIndex);
            if (cached) cached.matchedAnchorId = sn.matchedAnchorId;
          }
        }
      }

      const renderedText = treeObj?.renderedText || '';
      const nodes = rawNodes.slice(0, 35).map((n) => {
        const cached = typeof n.displayIndex === 'number' ? bcuNodeBoundsCache.get(n.displayIndex) : undefined;
        return {
          display_index: n.displayIndex,
          role: n.role,
          label: n.label || n.title || '',
          zone: cached?.zone ?? 'MAIN_STAGE',
          ...(cached?.matchedAnchorId ? { anchor_id: cached.matchedAnchorId } : {}),
        };
      });

      return JSON.stringify({
        ok: true,
        hgam_state: latestHGamEvaluation?.stateId ?? 'unknown',
        active_chat_header: latestHGamEvaluation?.activeHeaderTitle ?? null,
        is_target_contact_already_open: latestHGamEvaluation?.isTargetContactAlreadyOpen ?? false,
        composer_display_index: latestHGamEvaluation?.composerDisplayIndex ?? null,
        directive: latestHGamEvaluation?.dynamicDirective ?? null,
        tree_text: renderedText.slice(0, 1500),
        nodes,
        total_nodes: nodes.length,
      });
    }
    case 'bcu_click': {
      const bcuTarget = (await resolveBcuWindowId(windowId, appName)) ?? String(windowId);
      const clickPayload: Record<string, unknown> = {
        window: bcuTarget,
        imageMode: 'path',
      };

      const targetObj = args.target as { kind?: string; value?: number } | undefined;
      const cachedNode =
        targetObj?.kind === 'display_index' && typeof targetObj.value === 'number'
          ? bcuNodeBoundsCache.get(targetObj.value)
          : undefined;

      // TINGKAT 2 (HILIR): H-GAM TOP_HEADER Guardrail
      if (
        cachedNode &&
        cachedNode.zone === 'TOP_HEADER' &&
        !['back', 'kembali', 'close', 'tutup'].some((k) =>
          cachedNode.label.toLowerCase().includes(k),
        )
      ) {
        recordReflexionLesson(
          appName,
          `Elemen "${cachedNode.label}" di TOP_HEADER adalah judul obrolan aktif. Jangan diklik saat hendak mengirim pesan karena akan membuka panel profil; gunakan bcu_type_text.`,
        );
        return JSON.stringify({
          ok: false,
          blocked_by_hgam_guard: true,
          zone: 'TOP_HEADER',
          active_chat_header: latestHGamEvaluation?.activeHeaderTitle ?? cachedNode.label,
          composer_display_index: latestHGamEvaluation?.composerDisplayIndex ?? null,
          message: `DIBLOKIR OLEH H-GAM GUARD: Elemen "${cachedNode.label}" (display_index: ${targetObj?.value}) berada di zona TOP_HEADER. Mengeklik elemen ini akan membuka panel profil kontak. Obrolan sudah terbuka. Langsung gunakan "bcu_type_text" untuk mengetik pesan!`,
        });
      }

      const targetX = typeof args.x === 'number' ? args.x : (cachedNode?.centerX ?? Math.round(winWidth / 2));
      const targetY = typeof args.y === 'number' ? args.y : (cachedNode?.centerY ?? Math.round(winHeight / 2));
      const targetNormX = cachedNode?.normX ?? targetX / (winWidth || 1512);
      const targetNormY = cachedNode?.normY ?? targetY / (winHeight || 873);
      const clickLabel = cachedNode?.label ? `Klik: ${cachedNode.label.slice(0, 22)}` : 'Mengeklik';
      // Calculate Bounded Fitts's Law duration for approach glide
      const currentAction = getCursorAction();
      const fromNormX = currentAction?.norm_x ?? 0.5;
      const fromNormY = currentAction?.norm_y ?? 0.5;
      const dist = Math.hypot(targetNormX - fromNormX, targetNormY - fromNormY);
      const glideDuration = Math.min(320, Math.max(120, Math.round(110 + 220 * Math.log2(1 + dist / 0.04))));

      // Phase 1: Pre-Click Glide Animation on Canvas
      setCursorAction(windowId, targetX, targetY, false, {
        phase: 'move',
        label: clickLabel,
        duration_ms: glideDuration,
      });

      // Wait for visual arrival before physical click!
      await new Promise((r) => setTimeout(r, glideDuration));

      // Phase 2: Click Impact Ripple (duration_ms: 0 because cursor is already at target)
      setCursorAction(windowId, targetX, targetY, true, {
        phase: 'click',
        label: clickLabel,
        duration_ms: 0,
      });
      if (args.target && typeof args.target === 'object') {
        clickPayload.target = args.target;
      } else if (typeof args.x === 'number' && typeof args.y === 'number') {
        const meta = await resolveBcuWindowMeta(windowId, appName);
        const scaleX = meta?.scaleX && meta.scaleX > 0 ? meta.scaleX : 1.0;
        const scaleY = meta?.scaleY && meta.scaleY > 0 ? meta.scaleY : 1.0;
        clickPayload.x = Math.round(args.x / scaleX);
        clickPayload.y = Math.round(args.y / scaleY);
      } else if (cachedNode) {
        clickPayload.target = { kind: 'display_index', value: targetObj!.value };
      }
      if (typeof args.clickCount === 'number') {
        clickPayload.clickCount = args.clickCount;
      }

      const clickRes = await bcuCall('/v1/click', clickPayload);
      if (clickRes.ok && clickRes.data) {
        syncCursorFromBcuResponse(
          windowId,
          { x: targetX, y: targetY },
          clickRes.data as Record<string, unknown>,
          true,
          clickLabel,
          'click',
        );
      }
      bumpFrameVersion(windowId);
      return JSON.stringify(clickRes.data ?? { ok: clickRes.ok, error: clickRes.error });
    }

    case 'bcu_type_text': {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text) {
        return JSON.stringify({ ok: false, error: 'Parameter text diperlukan.' });
      }
      const bcuTarget = (await resolveBcuWindowId(windowId, appName)) ?? String(windowId);
      const typeRes = await bcuCall('/v1/type_text', {
        window: bcuTarget,
        text,
        focusAssistMode: args.focusAssistMode ?? 'focus_and_caret_end',
        imageMode: 'path',
      });
      if (typeRes.ok && typeRes.data) {
        const currentPos = getCursorAction();
        const typeFallback = {
          x: currentPos?.x ?? Math.round(winWidth / 2),
          y: currentPos?.y ?? Math.round(winHeight / 2),
        };
        syncCursorFromBcuResponse(
          windowId,
          typeFallback,
          typeRes.data as Record<string, unknown>,
          false,
          `Mengetik: "${text.slice(0, 18)}"`,
          'type',
        );
      }
      bumpFrameVersion(windowId);
      return JSON.stringify(typeRes.data ?? { ok: typeRes.ok, error: typeRes.error });
    }
    case 'bcu_press_key': {
      const key = typeof args.key === 'string' ? args.key : 'Return';
      const bcuTarget = (await resolveBcuWindowId(windowId, appName)) ?? String(windowId);
      const pressRes = await bcuCall('/v1/press_key', {
        window: bcuTarget,
        key,
        imageMode: 'path',
      });
      bumpFrameVersion(windowId);
      return JSON.stringify(pressRes.data ?? { ok: pressRes.ok, error: pressRes.error });
    }

    case 'bcu_scroll': {
      const bcuTarget = (await resolveBcuWindowId(windowId, appName)) ?? String(windowId);
      const scrollPayload: Record<string, unknown> = {
        window: bcuTarget,
        imageMode: 'path',
      };
      if (args.target) scrollPayload.target = args.target;
      if (typeof args.deltaY === 'number') scrollPayload.deltaY = args.deltaY;
      if (typeof args.deltaX === 'number') scrollPayload.deltaX = args.deltaX;

      const scrollRes = await bcuCall('/v1/scroll', scrollPayload);
      bumpFrameVersion(windowId);
      return JSON.stringify(scrollRes.data ?? { ok: scrollRes.ok, error: scrollRes.error });
    }

    case 'bcu_set_value': {
      if (!args.target) {
        return JSON.stringify({ ok: false, error: 'Target display_index diperlukan untuk set_value.' });
      }
      const bcuTarget = (await resolveBcuWindowId(windowId, appName)) ?? String(windowId);
      const valRes = await bcuCall('/v1/set_value', {
        window: bcuTarget,
        target: args.target,
        value: String(args.value ?? ''),
        imageMode: 'path',
      });
      bumpFrameVersion(windowId);
      return JSON.stringify(valRes.data ?? { ok: valRes.ok, error: valRes.error });
    }

    case 'bcu_perform_secondary_action': {
      if (!args.target) {
        return JSON.stringify({ ok: false, error: 'Target display_index diperlukan untuk secondary action.' });
      }
      const bcuTarget = (await resolveBcuWindowId(windowId, appName)) ?? String(windowId);
      const secRes = await bcuCall('/v1/perform_secondary_action', {
        window: bcuTarget,
        target: args.target,
        action: String(args.action ?? 'context_menu'),
        imageMode: 'path',
      });
      bumpFrameVersion(windowId);
      return JSON.stringify(secRes.data ?? { ok: secRes.ok, error: secRes.error });
    }

    case 'act_pause': {
      const reason = typeof args.reason === 'string' ? args.reason : 'Menunggu tindakan manual pengguna';
      const expectedState = typeof args.expected_state === 'string' ? args.expected_state : undefined;

      setTakeoverState({
        active: true,
        reason,
        app_name: appName,
        window_id: windowId,
        expected_state: expectedState,
      });

      return JSON.stringify({
        ok: true,
        status: 'paused_for_human_takeover',
        message: `Otomasi dijeda untuk kendali manual manusia: ${reason}`,
      });
    }

    case 'click_workspace': {
      const x = typeof args.x === 'number' ? args.x : undefined;
      const y = typeof args.y === 'number' ? args.y : undefined;
      const query = typeof args.query === 'string' ? args.query.trim() : undefined;
      const elementToken = typeof args.element_token === 'string' ? args.element_token.trim() : undefined;

      // 4-Step Deterministic Flow for WhatsApp chat search
      const isWhatsApp = appName.toLowerCase().includes('whatsapp');
      if (isWhatsApp && query && x === undefined && y === undefined && !elementToken) {
        // Step 1: Observe first to see if contact is already visible in chat list
        const obs = await perceptionObserveWorkspace({
          windowId,
          query,
          provider: 'apple_vision',
          settleDelayMs: 200,
        });

        // Step 2: If found on screen, click directly in background
        if (obs.elements.length > 0) {
          const target = obs.elements[0]!;
          setCursorAction(windowId, target.center_x, target.center_y, false, { phase: 'move', label: `Chat: ${query}` });
          await new Promise((r) => setTimeout(r, 80));
          setCursorAction(windowId, target.center_x, target.center_y, true, { phase: 'click', label: `Chat: ${query}` });
          await cuaClick(target.center_x, target.center_y, windowId, pid, 'background');
          bumpFrameVersion(windowId);
          await new Promise((r) => setTimeout(r, 350));
          return JSON.stringify({
            ok: true,
            method: 'direct_chat_click',
            contact: query,
            x: target.center_x,
            y: target.center_y,
            message: `Kontak "${query}" ditemukan di WhatsApp dan berhasil dibuka.`,
          });
        }

        // Step 3: Deterministic Search Fallback in background
        // 1. Visually animate virtual cursor to search box in canvas
        const searchX = Math.round((winWidth || 1512) * 0.18);
        const searchY = Math.round((winHeight || 873) * 0.12);
        setCursorAction(windowId, searchX, searchY, false, { phase: 'move', label: `Search: ${query}` });
        await new Promise((r) => setTimeout(r, 100));
        setCursorAction(windowId, searchX, searchY, true, { phase: 'click', label: `Search: ${query}` });

        const hkRes = await cuaHotkey(['Command', 'f'], windowId, pid, 'background');
        if (hkRes.includes('Ditolak') || hkRes.includes('refused')) {
          return JSON.stringify({
            ok: false,
            message: `Aksi background ke WhatsApp ditolak oleh macOS karena jendela WhatsApp berada di Space virtual lain (Desktop lain) atau sedang tertutup. Silakan geser jendela WhatsApp ke layar aktif agar dapat dikontrol di latar belakang.`,
          });
        }

        await new Promise((r) => setTimeout(r, 220));
        setCursorAction(windowId, searchX, searchY, false, { phase: 'type', label: `Type: ${query}` });
        await cuaTypeText(query, windowId, pid, { x: searchX, y: searchY }, 'background');
        await new Promise((r) => setTimeout(r, 450));

        // 3. Re-observe search results
        const searchObs = await perceptionObserveWorkspace({
          windowId,
          query,
          provider: 'apple_vision',
          settleDelayMs: 200,
        });

        // Elements below search box (center_y > 110)
        const resultRow = searchObs.elements.find((e) => e.center_y > 110);
        if (resultRow) {
          setCursorAction(windowId, resultRow.center_x, resultRow.center_y, true, { phase: 'click', label: `Open: ${query}` });
          await cuaClick(resultRow.center_x, resultRow.center_y, windowId, pid, 'background');
          bumpFrameVersion(windowId);
          return JSON.stringify({
            ok: true,
            method: 'search_fallback_click',
            contact: query,
            message: `Kontak "${query}" ditemukan di hasil pencarian WhatsApp dan berhasil dibuka.`,
          });
        }

        return JSON.stringify({
          ok: false,
          message: `Kontak "${query}" tidak ditemukan di WhatsApp Anda setelah dicari di latar belakang.`,
        });
      }

      const clickRes = await cuaClickElementOrCoords({
        elementToken,
        query,
        x,
        y,
        windowId,
        pid,
      });
      bumpFrameVersion(windowId);
      await new Promise((r) => setTimeout(r, 350));
      return JSON.stringify(clickRes);
    }

    case 'type_in_workspace': {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text) {
        return JSON.stringify({ ok: false, error: 'Parameter text tidak boleh kosong.' });
      }

      const targetField = typeof args.target_field === 'string' ? args.target_field : 'composer';
      const submitWithEnter = args.submit_with_enter !== false;
      let targetX = typeof args.x === 'number' ? args.x : undefined;
      let targetY = typeof args.y === 'number' ? args.y : undefined;

      // Smart Composer Targeting
      if (targetField === 'composer' && (targetX === undefined || targetY === undefined)) {
        targetX = Math.round((winWidth || 1512) * 0.65);
        targetY = (winHeight || 873) - 35;

        const inputObs = await perceptionObserveWorkspace({
          windowId,
          provider: 'apple_vision',
          settleDelayMs: 150,
        });

        const composerEl = inputObs.elements.find((e) => {
          const isAtBottom = e.center_y > (winHeight || 873) * 0.88;
          const isInRightPane = e.center_x > (winWidth || 1512) * 0.35;
          const lower = e.label.toLowerCase();
          return isAtBottom && isInRightPane && (lower.includes('pesan') || lower.includes('type') || lower.includes('message') || lower.includes('ketik'));
        });

        if (composerEl) {
          targetX = Math.round(composerEl.center_x);
          targetY = Math.round(composerEl.center_y);
        }
      } else if (targetField === 'search' && (targetX === undefined || targetY === undefined)) {
        targetX = Math.round((winWidth || 1512) * 0.18);
        targetY = Math.round((winHeight || 873) * 0.12);
      }

      const coords = targetX !== undefined && targetY !== undefined ? { x: targetX, y: targetY } : undefined;
      if (coords) {
        await cuaClick(targetX!, targetY!, windowId, pid, 'background');
        await new Promise((r) => setTimeout(r, 200));
      }

      const typeRes = await cuaTypeText(text, windowId, pid, coords, 'background');
      await new Promise((r) => setTimeout(r, 150));

      if (submitWithEnter) {
        await cuaPressKey('Return', windowId, pid, 'background');
        await new Promise((r) => setTimeout(r, 300));
      }

      bumpFrameVersion(windowId);
      return JSON.stringify({
        ok: true,
        typed_text: text,
        target_field: targetField,
        focused_at: coords ?? 'current_focus',
        submitted_with_enter: submitWithEnter,
        cua_response: typeRes,
      });
    }

    case 'press_key_in_workspace': {
      if (Array.isArray(args.hotkey) && args.hotkey.length > 0) {
        const keys = args.hotkey.map((k) => String(k));
        const hkRes = await cuaHotkey(keys, windowId, pid, 'background');
        bumpFrameVersion(windowId);
        await new Promise((r) => setTimeout(r, 250));
        return JSON.stringify({ ok: true, hotkey: keys, cua_response: hkRes });
      }

      const key = typeof args.key === 'string' ? args.key : 'Return';
      const keyRes = await cuaPressKey(key, windowId, pid, 'background');
      bumpFrameVersion(windowId);
      await new Promise((r) => setTimeout(r, 250));
      return JSON.stringify({ ok: true, key, cua_response: keyRes });
    }

    case 'navigate_browser': {
      if (surface.surface_kind !== 'web_browser') {
        return JSON.stringify({
          ok: false,
          error: `Aksi ditolak: Jendela aktif "${surface.app_name}" bukan web browser. Navigasi URL hanya diizinkan untuk browser seperti Safari atau Google Chrome.`,
        });
      }

      const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
      if (!rawUrl) {
        return JSON.stringify({ ok: false, error: 'Parameter url diperlukan.' });
      }

      const navRes = cuaNavigateBrowserBackground(surface.app_name, rawUrl);
      bumpFrameVersion(windowId);
      await new Promise((r) => setTimeout(r, 600));
      return JSON.stringify(navRes);
    }

    default:
      return JSON.stringify({ ok: false, error: `Tool tidak dikenal: ${String(call.tool)}` });
  }
}

async function runOmpReAct(options: {
  surface: ActiveSurface | null;
  prompt: string;
  transcript: string;
  runtime: OmpRuntimeContext;
  maxSteps: number;
  perStepTimeoutMs: number;
  signal?: AbortSignal;
  logSink: ExecutionLogEntry[];
  buildSystemPrompt: (
    runtimeEval: HGamRuntimeEvaluation | null,
  ) => string;
}): Promise<OmpReActResult> {
  const {
    surface,
    prompt,
    transcript,
    runtime,
    maxSteps,
    perStepTimeoutMs,
    signal,
    logSink,
    buildSystemPrompt,
  } = options;
  const scratchpad: string[] = [];
  const logs: ExecutionLogEntry[] = [];
  let finalReply = '';
  let paused = false;
  let timedOut = false;

  for (let step = 1; step <= maxSteps; step++) {
    signal?.throwIfAborted();
    const dynamicSystemPrompt = buildSystemPrompt(latestHGamEvaluation);
    const stepPrompt = [
      dynamicSystemPrompt,
      '',
      'RIWAYAT PERCAKAPAN:',
      transcript || 'Belum ada riwayat percakapan.',
      '',
      `INSTRUKSI PENGGUNA SAAT INI: "${prompt}"`,
      '',
      scratchpad.length > 0
        ? `JEJAK EKSEKUSI REACT SEJAUH INI:\n${scratchpad.join('\n\n')}`
        : surface
          ? 'Belum ada tool yang dipanggil pada giliran ini. Mulai dengan memanggil bcu_observe untuk mendeteksi State layar saat ini.'
          : runtime.jitEnabled &&
              runtime.delegationDepth === 0 &&
              runtime.currentDot &&
              runtime.spaceId
            ? 'Tidak ada aplikasi aktif yang terikat. Jangan memanggil tool desktop. Untuk tugas deterministik, gunakan jit_synthesize_and_run; jika tidak, gunakan final_answer.'
            : 'Tidak ada aplikasi aktif yang terikat. Jangan memanggil tool desktop; selesaikan tugas dengan penalaran atau gunakan final_answer.',
      '',
      `INSTRUKSI GILIRAN INI (Langkah ${step}/${maxSteps}):`,
      'Berikan 1 objek JSON keputusan Anda berikutnya (tool call atau final_answer):',
    ].join('\n');

    const rawDecision = await executeOmpSandboxed(stepPrompt, {
      timeoutMs: perStepTimeoutMs,
      signal,
    });
    if (rawDecision.includes('Waktu tunggu penalaran OMP habis')) {
      timedOut = true;
    }
    const decision = parseReActDecision(rawDecision);

    if (decision.tool === 'final_answer') {
      finalReply =
        decision.answer || 'Selesai menjalankan instruksi di workspace Anda.';
      break;
    }

    if (decision.tool === 'act_pause') {
      const reason =
        (decision.args?.reason as string) ||
        'Konfirmasi manual pengguna diperlukan.';
      await executeWorkspaceTool(decision, surface, prompt, runtime);
      finalReply = `Kendali diserahkan kepada Anda: ${reason}. Silakan lakukan tindakan di layar (atau gunakan tombol Bawa ke Depan di kanvas Workspace), lalu klik "Lanjutkan Otomasi" jika sudah selesai.`;
      paused = true;
      break;
    }

    console.log(`\n======================================================`);
    console.log(`[REACT STEP ${step}/${maxSteps}]`);
    console.log(`THOUGHT: ${decision.thought ?? 'Thinking...'}`);
    console.log(`ACTION: ${decision.tool}`, JSON.stringify(decision.args ?? {}));
    const observation = await executeWorkspaceTool(
      decision,
      surface,
      prompt,
      runtime,
    );
    console.log(`OBSERVATION: ${observation.slice(0, 300)}...`);
    console.log(`======================================================\n`);

    const entry: ExecutionLogEntry = {
      step,
      thought: decision.thought,
      tool: decision.tool,
      args: decision.args,
      observation: observation.slice(0, 500),
      timestamp: Date.now(),
    };
    logs.push(entry);
    logSink.push(entry);

    scratchpad.push(
      `[STEP ${step} ACTION]: ${JSON.stringify({ thought: decision.thought, tool: decision.tool, args: decision.args })}\n[STEP ${step} OBSERVATION]: ${observation}`,
    );
    if (
      decision.tool === 'jit_synthesize_and_run' &&
      observation.includes('"status":"approval_required"')
    ) {
      finalReply =
        'Saya sudah menyiapkan skrip JIT. Skrip belum dijalankan. Tinjau kode lalu setujui melalui perintah persetujuan di bawah.';
      break;
    }
    if (step === maxSteps) {
      finalReply =
        'Batas langkah penalaran tercapai. Tindakan telah dijalankan pada jendela workspace Anda.';
    }
  }

  if (logs.length > 0 && !finalReply.includes('Jejak Langkah')) {
    const stepSummary = logs
      .map((entry) => `- Langkah ${entry.step}: ${entry.thought || entry.tool} (\`${entry.tool}\`)`)
      .join('\n');
    finalReply = `${finalReply}\n\n**Jejak Langkah Tindakan:**\n${stepSummary}`;
  }

  return { finalReply, logs, paused, timedOut };
}

export async function handleJitChatCommand(
  prompt: string,
  context: JitApprovalContext,
): Promise<string | null> {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/jit-')) return null;

  if (/^\/jit-list\s*$/i.test(trimmed)) {
    const pending = listJitApprovals(context);
    if (pending.length === 0) {
      return 'No pending JIT approvals in this conversation.';
    }
    return [
      'Pending JIT approvals in this conversation:',
      ...pending.map(
        (approval) =>
          `- \`${approval.id}\` — ${approval.goal} (${approval.reviewedAt ? 'reviewed' : 'not reviewed'}) · \`/jit-review ${approval.id}\``,
      ),
    ].join('\n');
  }

  const match = /^\/(jit-review|jit-approve|jit-deny)\s+([0-9a-f-]{36})$/i.exec(
    trimmed,
  );
  if (!match) {
    return 'Invalid JIT command. Use `/jit-list`, `/jit-review <id>`, `/jit-approve <id>`, or `/jit-deny <id>`.';
  }

  const action = match[1].toLowerCase();
  const id = match[2].toLowerCase();
  try {
    if (action === 'jit-review') {
      const approval = reviewJitApproval(id, context);
      return [
        `JIT approval \`${approval.id}\` is ready for review.`,
        `Goal: ${approval.goal}`,
        `Expires: ${new Date(approval.expiresAt).toISOString()}`,
        '',
        'Warning: after approval this script runs as your macOS user. It is not an OS sandbox. Review every line and every argument.',
        '',
        '````javascript',
        approval.code,
        '````',
        '',
        'Approved arguments:',
        '```json',
        JSON.stringify(approval.argsJson, null, 2).slice(0, 4000),
        '```',
        '',
        `To approve, send \`/jit-approve ${approval.id}\`. To reject, send \`/jit-deny ${approval.id}\`.`,
      ].join('\n');
    }

    if (action === 'jit-approve') {
      const result = await approveJitApproval(id, context);
      const lines = [
        `JIT approval \`${id}\` executed: ${result.ok ? 'success' : 'failed'}.`,
        `Exit code: ${result.exitCode ?? 'null'} · Duration: ${result.durationMs}ms${result.timedOut ? ' · timed out' : ''}`,
      ];
      if (result.parsedJson !== undefined) {
        lines.push(
          '',
          '```json',
          JSON.stringify(result.parsedJson, null, 2).slice(0, 6000),
          '```',
        );
      } else if (result.stdout) {
        lines.push('', '```', result.stdout.slice(0, 6000), '```');
      }
      if (result.stderr) {
        lines.push('', '**stderr**', '```', result.stderr.slice(0, 6000), '```');
      }
      return lines.join('\n');
    }

    const approval = denyJitApproval(id, context);
    return `JIT approval \`${approval.id}\` denied. The script was not executed.`;
  } catch (error) {
    return `JIT command failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function handleOmpChatCompletion(
  c: Context,
  platform?: { workspace: WorkspaceStore },
) {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      stream?: boolean;
      model?: string;
      dotId?: string;
      spaceId?: string;
      threadId?: string;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];

    // 1. Build conversation transcript from last 8 messages
    const conversationHistory = messages.slice(-8);
    const conversationTranscript = conversationHistory
      .map((m) => {
        const role = (m.role || 'user').toUpperCase();
        let content = '';
        if (typeof m.content === 'string') {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          content = (m.content as Array<{ text?: string }>).map((c) => c.text ?? '').join(' ');
        }
        return `${role}: ${content}`;
      })
      .join('\n');

    const lastUserMsg = messages.findLast((m) => m.role === 'user')?.content ?? '';
    const promptStr = typeof lastUserMsg === 'string' ? lastUserMsg : '';

    // 2. Resolve Dot/Space context before surface binding so owner approval
    // commands can run without requiring a desktop window.
    const workspace = platform?.workspace;
    const requestedDotId =
      typeof body.dotId === 'string' ? body.dotId : undefined;
    const currentDot = workspace
      ? requestedDotId
        ? workspace.dot(requestedDotId)
        : workspace.dots()[0]
      : undefined;
    const spaceId =
      currentDot &&
      typeof body.spaceId === 'string' &&
      currentDot.spaceIds.includes(body.spaceId)
        ? body.spaceId
        : currentDot?.spaceId;
    const threadId =
      typeof body.threadId === 'string' && body.threadId
        ? body.threadId
        : 'omp-chat';
    const collaborators =
      workspace && currentDot && spaceId
        ? workspace
            .dots()
            .filter(
              (dot) =>
                dot.id !== currentDot.id && dot.spaceIds.includes(spaceId),
            )
        : [];
    const jitEnabled = process.env.IZABOT_ENABLE_JIT !== '0';

    if (promptStr.trim().startsWith('/jit-')) {
      if (!currentDot || !spaceId) {
        return c.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? 'omp-default',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'JIT commands require an active Dot and Space.',
              },
              finish_reason: 'stop',
            },
          ],
        });
      }
      const jitReply = await handleJitChatCommand(promptStr, {
        threadId,
        dotId: currentDot.id,
        spaceId,
      });
      if (jitReply) {
        return c.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? 'omp-default',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: jitReply,
              },
              finish_reason: 'stop',
            },
          ],
        });
      }
    }

    // 3. Resolve active workspace surface strictly avoiding app drift
    const { surface: activeSurface, mismatchReason } = await resolveBoundSurface(promptStr);

    if (!activeSurface && mismatchReason) {
      return c.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? 'omp-default',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: mismatchReason,
            },
            finish_reason: 'stop',
          },
        ],
      });
    }

    const progressEvents: string[] = [];
    const runtime: OmpRuntimeContext = {
      workspace,
      currentDot,
      spaceId,
      threadId,
      delegationDepth: 0,
      maxDelegationDepth: MAX_DELEGATION_DEPTH,
      collaborators,
      activeSurface,
      progressEvents,
      onProgress: (message) => console.log(`[SWARM] ${message}`),
      jitEnabled,
      jitApprovals: [],
    };

    latestHGamEvaluation = null;
    latestExecutionLogs = [];

    // 3. Autonomous ReAct Execution Loop (max 8 steps)
    const reactResult = await runOmpReAct({
      surface: activeSurface,
      prompt: promptStr,
      transcript: conversationTranscript,
      runtime,
      maxSteps: MAX_REACT_STEPS,
      perStepTimeoutMs: 60_000,
      logSink: latestExecutionLogs,
      buildSystemPrompt: (runtimeEval) =>
        buildReActSystemPrompt(
          activeSurface,
          promptStr,
          runtimeEval,
          runtime,
        ),
    });
    let finalReply =
      reactResult.finalReply || 'Selesai memproses permintaan Anda.';
    if (progressEvents.length > 0) {
      const trace = progressEvents
        .slice(-10)
        .map((line) => `- ${line}`)
        .join('\n');
      finalReply = `${finalReply}\n\n**Delegation Trace:**\n${trace}`;
    }
    if (runtime.jitApprovals.length > 0) {
      const approvals = runtime.jitApprovals
        .slice(-5)
        .map(
          (approval) =>
            `- **${approval.goal}** — ID \`${approval.id}\`\n  Review: \`/jit-review ${approval.id}\` · Approve: \`/jit-approve ${approval.id}\` · Deny: \`/jit-deny ${approval.id}\``,
        )
        .join('\n');
      finalReply = `${finalReply}\n\n**JIT Script Approval Required (not executed yet):**\n${approvals}\n\nReview the full code before approving. Approved scripts run as your macOS user; this is not an OS sandbox.`;
    }
    const isStreaming = Boolean(body.stream);
    const id = `chatcmpl-${Date.now()}`;
    const model = body.model ?? 'omp-default';

    if (!isStreaming) {
      return c.json({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: finalReply,
            },
            finish_reason: 'stop',
          },
        ],
      });
    }

    return streamText(c, async (stream) => {
      const chunk = {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content: finalReply },
            finish_reason: 'stop',
          },
        ],
      };
      await stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
      await stream.write('data: [DONE]\n\n');
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[OMP Chat Completion Error]:', error);
    return c.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'omp-default',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `Maaf, terjadi kendala saat menjalankan penalaran: ${msg}`,
          },
          finish_reason: 'stop',
        },
      ],
    });
  }
}
