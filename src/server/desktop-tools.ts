// SPDX-License-Identifier: MIT
// Universal desktop automation tools bridging izabot to Background Computer Use & Cua Driver (port 3211)

import { execSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  runPerceptionListWindows,
  perceptionObserveWorkspace,
  type UIElement,
  type PerceptionObserveResult,
} from './perception-engine.js';
import {
  getActiveSurface,
  setCursorAction,
  bumpFrameVersion,
  getLatestFramePath,
  type ActiveSurface,
} from './active-surface.js';
import { getLatestMemoryFrame } from './window-stream-hub.js';
export { perceptionObserveWorkspace, type UIElement, type PerceptionObserveResult };

const CUA_MCP_URL =
  process.env.CUA_MCP_URL ?? 'http://127.0.0.1:3211/mcp';

// ZERO INTRUSION INVARIANT: delivery_mode is strictly 'background'
export type CuaDeliveryMode = 'background';

export interface CuaAppInfo {
  name: string;
  pid?: number;
  bundleId?: string;
  running: boolean;
}

export interface ConnectedWindow {
  window_id: number;
  pid: number;
  app_name: string;
  title: string;
  width: number;
  height: number;
}

export interface SendInputOptions {
  windowId?: number;
  pid?: number;
  appName?: string;
  contactOrRecipient?: string;
  text: string;
  submitWithEnter?: boolean;
}

export interface CuaStructuredResult {
  rawText: string;
  isError: boolean;
  effect?: string;
  code?: string;
  recommendedEscalation?: string;
  snapshotId?: string;
  elements?: Array<{
    element_token?: string;
    role?: string;
    label?: string;
    title?: string;
    value?: string;
    bounds?: { x: number; y: number; width: number; height: number };
  }>;
  structuredContent?: Record<string, unknown>;
}

/**
 * Resolves the background-computer-use HTTP daemon endpoint if running.
 */
export function resolveBcuBaseUrl(): string | null {
  if (process.env.BCU_BASE_URL) return process.env.BCU_BASE_URL.replace(/\/$/, '');
  const candidates = [
    path.join(os.tmpdir(), 'background-computer-use', 'runtime-manifest.json'),
    '/tmp/background-computer-use/runtime-manifest.json',
  ];
  for (const manifestPath of candidates) {
    if (existsSync(manifestPath)) {
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { baseURL?: string };
        if (raw.baseURL) return raw.baseURL.replace(/\/$/, '');
      } catch {}
    }
  }
  return null;
}

/**
 * Calls background-computer-use HTTP daemon with strict cursor prevention.
 */
export async function bcuCall(
  route: string,
  payload: Record<string, unknown> = {},
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const baseUrl = resolveBcuBaseUrl();
  if (!baseUrl) return { ok: false, error: 'BCU daemon not running' };

  const sanitized = { ...payload };
  // CRITICAL (Option B): NEVER send cursor field to BCU so NSWindow is never shown on Mac host screen
  delete sanitized.cursor;
  try {
    const res = await fetch(`${baseUrl}${route.startsWith('/') ? route : `/${route}`}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sanitized),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, error: `BCU HTTP ${res.status}: ${txt}` };
    }
    const data = (await res.json()) as Record<string, unknown>;
    const screenshotObj = data.screenshot as { image?: { imagePath?: string } } | undefined;
    const imgPath =
      screenshotObj?.image?.imagePath ||
      (typeof data.screenshotPath === 'string'
        ? data.screenshotPath
        : typeof data.imagePath === 'string'
          ? data.imagePath
          : undefined);

    const winId =
      typeof sanitized.window === 'string'
        ? parseInt(sanitized.window, 10)
        : typeof sanitized.window_id === 'number'
          ? sanitized.window_id
          : undefined;

    if (winId && imgPath) {
      bumpFrameVersion(winId, imgPath);
    }
    return { ok: true, data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export interface BcuWindowMeta {
  bcuWindowId: string;
  scaleX: number;
  scaleY: number;
  timestamp: number;
}

const bcuWindowMap = new Map<number, BcuWindowMeta>();

export async function resolveBcuWindowMeta(
  windowNumber: number,
  appName?: string,
): Promise<BcuWindowMeta | null> {
  const cached = bcuWindowMap.get(windowNumber);
  if (cached && Date.now() - cached.timestamp < 10000) {
    return cached;
  }

  const baseUrl = resolveBcuBaseUrl();
  if (!baseUrl) return null;

  const targetApp = appName ?? getActiveSurface()?.app_name;
  if (!targetApp) return null;

  try {
    const res = await fetch(`${baseUrl}/v1/list_windows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: targetApp }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      windows?: Array<{
        windowNumber: number;
        windowID: string;
        frameAppKit?: { width: number; height: number };
      }>;
    };

    for (const w of data.windows ?? []) {
      let scaleX = 1.0;
      let scaleY = 1.0;
      try {
        const stateRes = await fetch(`${baseUrl}/v1/get_window_state`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            window: w.windowID,
            imageMode: 'path',
          }),
        });
        if (stateRes.ok) {
          const stateData = (await stateRes.json()) as {
            screenshot?: {
              coordinateContract?: {
                modelFacingScreenshot?: {
                  scaleToWindowLogical?: { x: number; y: number };
                };
              };
              image?: { imagePath?: string };
            };
          };
          const scale = stateData.screenshot?.coordinateContract?.modelFacingScreenshot?.scaleToWindowLogical;
          if (scale?.x && scale?.y) {
            scaleX = scale.x;
            scaleY = scale.y;
          }
        }
      } catch {}

      bcuWindowMap.set(w.windowNumber, {
        bcuWindowId: w.windowID,
        scaleX,
        scaleY,
        timestamp: Date.now(),
      });
    }
    return bcuWindowMap.get(windowNumber) ?? null;
  } catch {
    return null;
  }
}

export async function resolveBcuWindowId(
  windowNumber: number,
  appName?: string,
): Promise<string | null> {
  const meta = await resolveBcuWindowMeta(windowNumber, appName);
  return meta?.bcuWindowId ?? null;
}

export function syncCursorFromBcuResponse(
  windowId: number,
  logicalFallback: { x: number; y: number },
  bcuData?: Record<string, unknown>,
  isClicking = true,
  labelOverride?: string,
  phaseOverride?: 'click' | 'move' | 'type',
): void {
  const winInfo = bcuData?.window as
    | { frameAppKit?: { x: number; y: number; width: number; height: number } }
    | undefined;

  const pt =
    (bcuData?.action as { targetPointAppKit?: { x: number; y: number } } | undefined)?.targetPointAppKit ??
    (bcuData?.coordinate as { targetPointAppKit?: { x: number; y: number } } | undefined)?.targetPointAppKit ??
    (bcuData?.cursor as { targetPointAppKit?: { x: number; y: number } } | undefined)?.targetPointAppKit;

  const cursorSession = (bcuData?.cursor as { session?: { name?: string; color?: string } } | undefined)?.session;
  const finalLabel = labelOverride ?? cursorSession?.name ?? 'izabot Agent';
  const finalPhase = phaseOverride ?? (isClicking ? 'click' : 'move');
  const frame = winInfo?.frameAppKit;

  if (frame && pt && frame.width > 0 && frame.height > 0) {
    const localX = pt.x - frame.x;
    const localY = frame.y + frame.height - pt.y;
    setCursorAction(windowId, localX, localY, isClicking, {
      phase: finalPhase,
      label: finalLabel,
      duration_ms: isClicking ? 0 : undefined,
    });
    return;
  }

  setCursorAction(windowId, logicalFallback.x, logicalFallback.y, isClicking, {
    phase: finalPhase,
    label: finalLabel,
    duration_ms: isClicking ? 0 : undefined,
  });
}

export async function cuaCallToolDetailed(
  name: string,
  args: Record<string, unknown> = {},
): Promise<CuaStructuredResult> {
  try {
    // CUA HTTP daemon transport on port 3211 rejects the 'session' field with "session is not available to this transport".
    // Therefore, do not inject session into HTTP daemon calls.
    const payloadArgs: Record<string, unknown> = { ...args };
    delete payloadArgs.session;

    const res = await fetch(CUA_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name,
          arguments: payloadArgs,
        },
      }),
    });

    if (!res.ok) {
      console.error(`[CUA MCP Tool HTTP Error]: ${name}`, res.status, res.statusText);
      return {
        rawText: `Cua Driver HTTP ${res.status}: ${res.statusText}`,
        isError: true,
      };
    }

    const json = (await res.json()) as {
      result?: {
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };
      error?: { message?: string };
    };

    if (json.error) {
      console.error(`[CUA MCP Tool Error]: ${name}`, json.error.message);
      return {
        rawText: `Cua Driver Error: ${json.error.message ?? 'Unknown error'}`,
        isError: true,
      };
    }

    const isError = Boolean(json.result?.isError);
    let rawText = (json.result?.content ?? []).map((c) => c.text ?? '').join('\n');
    let structuredContent = json.result?.structuredContent as Record<string, unknown> | undefined;

    // Parse JSON inside textOutput if structuredContent is empty
    if (!structuredContent && rawText.startsWith('{') && rawText.endsWith('}')) {
      try {
        structuredContent = JSON.parse(rawText) as Record<string, unknown>;
      } catch {}
    }

    if (rawText.trim().length === 0 && structuredContent) {
      rawText =
        (structuredContent.summary as string) ??
        (structuredContent.action as string) ??
        (Object.keys(mergedSafe(structuredContent)).length > 0 ? JSON.stringify(structuredContent) : 'Action successful.');
    }

    const effect = typeof structuredContent?.effect === 'string' ? structuredContent.effect : undefined;
    const code = typeof structuredContent?.code === 'string' ? structuredContent.code : undefined;
    const recommendedEscalation =
      typeof (structuredContent?.escalation as Record<string, unknown>)?.recommended === 'string'
        ? ((structuredContent?.escalation as Record<string, unknown>).recommended as string)
        : undefined;

    const snapshotId =
      typeof structuredContent?.snapshot_id === 'string'
        ? (structuredContent.snapshot_id as string)
        : typeof (structuredContent?.snapshot as Record<string, unknown> | undefined)?.id === 'string'
          ? ((structuredContent?.snapshot as Record<string, unknown>).id as string)
          : undefined;

    const elements = Array.isArray(structuredContent?.elements)
      ? (structuredContent.elements as CuaStructuredResult['elements'])
      : undefined;

    return {
      rawText: rawText || (isError ? 'Action failed' : 'Action successful'),
      isError,
      effect,
      code,
      recommendedEscalation,
      snapshotId,
      elements,
      structuredContent,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      rawText: `Gagal menghubungi Cua Driver (port 3211): ${msg}`,
      isError: true,
    };
  }
}

function mergedSafe(obj: Record<string, unknown>): Record<string, unknown> {
  const c = { ...obj };
  delete c.timestamp;
  delete c.window_id;
  delete c.pid;
  return c;
}

export async function cuaCallTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const res = await cuaCallToolDetailed(name, args);
  return res.rawText;
}

let lastSnapshotWindowId: number | null = null;
let lastSnapshotTime = 0;
let lastSnapshotElements: NonNullable<CuaStructuredResult['elements']> = [];

export async function ensureWindowSnapshot(
  pid: number,
  windowId: number,
  force = false,
): Promise<CuaStructuredResult | null> {
  const now = Date.now();
  if (
    !force &&
    lastSnapshotWindowId === windowId &&
    now - lastSnapshotTime < 8000 &&
    lastSnapshotElements.length > 0
  ) {
    return null;
  }

  const res = await cuaCallToolDetailed('get_window_state', {
    pid,
    window_id: windowId,
  });

  if (!res.isError) {
    lastSnapshotWindowId = windowId;
    lastSnapshotTime = Date.now();
    lastSnapshotElements = res.elements ?? [];
  } else {
    console.error('[CUA get_window_state Refused]:', res.rawText);
  }
  return res;
}

/**
 * Background-only dispatcher with ZERO focus-stealing or foreground escalation.
 */
export async function cuaCallWithBackgroundLadder(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const pid = typeof args.pid === 'number' ? args.pid : undefined;
  const windowId = typeof args.window_id === 'number' ? args.window_id : undefined;

  if (pid && windowId) {
    await ensureWindowSnapshot(pid, windowId, false);
  }

  const bgArgs: Record<string, unknown> = {
    ...args,
    delivery_mode: 'background',
  };

  let attempt = await cuaCallToolDetailed(name, bgArgs);

  if (
    pid &&
    windowId &&
    (attempt.code === 'screenshot_context_missing' ||
      attempt.code === 'stale_element_token' ||
      attempt.rawText.includes('screenshot_context_missing') ||
      attempt.rawText.includes('stale_element_token'))
  ) {
    await ensureWindowSnapshot(pid, windowId, true);
    attempt = await cuaCallToolDetailed(name, bgArgs);
  }

  // ZERO FOREGROUND INVASION: Never escalate to foreground!
  if (attempt.isError || attempt.effect === 'suspected_noop' || attempt.effect === 'refused') {
    return `[Aksi Background]: Ditolak oleh macOS karena jendela tidak terisolasi atau di-minimize (${attempt.rawText})`;
  }

  return attempt.rawText;
}

export async function cuaListApps(): Promise<string> {
  return cuaCallTool('list_apps');
}

export async function cuaListWindows(): Promise<string> {
  return cuaCallTool('list_windows');
}

export async function cuaLaunchApp(appName: string): Promise<string> {
  return cuaCallTool('launch_app', { name: appName });
}

export async function cuaGetWindowState(
  pid: number,
  windowId?: number,
): Promise<string> {
  const args: Record<string, unknown> = { pid };
  if (windowId !== undefined) args.window_id = windowId;
  return cuaCallTool('get_window_state', args);
}

export async function cuaClick(
  x: number,
  y: number,
  windowId?: number,
  pid?: number,
  _deliveryMode: CuaDeliveryMode = 'background',
): Promise<string> {
  const active = getActiveSurface();
  const resolvedWindowId = windowId ?? active?.window_id;
  let resolvedPid =
    pid ?? (active && active.window_id === resolvedWindowId ? active.pid : active?.pid);

  if (!resolvedPid && resolvedWindowId) {
    const wins = await getConnectedWindows();
    resolvedPid = wins.find((w) => w.window_id === resolvedWindowId)?.pid;
  }

  if (resolvedWindowId) {
    const width = active?.width || 1280;
    const height = active?.height || 800;
    const targetNormX = Math.max(0, Math.min(1, x / width));
    const targetNormY = Math.max(0, Math.min(1, y / height));

    const glideDuration = Math.min(
      340,
      Math.max(120, Math.round(110 + 220 * Math.log2(1 + Math.hypot(targetNormX - 0.5, targetNormY - 0.5) / 0.04))),
    );

    // Phase 1: Approach glide
    setCursorAction(resolvedWindowId, Math.round(x), Math.round(y), false, {
      phase: 'move',
      label: 'izabot Agent',
      duration_ms: glideDuration,
    });

    // Phase 2: Wait for visual arrival before physical click
    await new Promise((r) => setTimeout(r, Math.min(220, glideDuration)));
  }
  // 1. Try background-computer-use with precise coordinate scaling
  if (resolveBcuBaseUrl() && resolvedWindowId) {
    const meta = await resolveBcuWindowMeta(resolvedWindowId, active?.app_name);
    const bcuTarget = meta?.bcuWindowId ?? String(resolvedWindowId);
    const scaleX = meta?.scaleX && meta.scaleX > 0 ? meta.scaleX : 1.0;
    const scaleY = meta?.scaleY && meta.scaleY > 0 ? meta.scaleY : 1.0;

    // Correct scale division: WindowLogical / scaleToWindowLogical = ScreenshotPixels
    const bcuX = Math.round(x / scaleX);
    const bcuY = Math.round(y / scaleY);

    const bcuRes = await bcuCall('/v1/click', {
      window: bcuTarget,
      x: bcuX,
      y: bcuY,
      clickCount: 1,
      imageMode: 'path',
    });

    if (bcuRes.ok) {
      syncCursorFromBcuResponse(
        resolvedWindowId,
        { x, y },
        bcuRes.data as Record<string, unknown> | undefined,
        true,
      );
      bumpFrameVersion(resolvedWindowId);
      return JSON.stringify(bcuRes.data);
    }
  }

  // 2. Fallback to CUA MCP daemon with delivery_mode: 'background'
  const res = await cuaCallWithBackgroundLadder('click', {
    x: Math.round(x),
    y: Math.round(y),
    window_id: resolvedWindowId,
    pid: resolvedPid,
    delivery_mode: 'background',
  });

  if (resolvedWindowId) {
    bumpFrameVersion(resolvedWindowId);
  }
  return res;
}

export async function cuaClickElementOrCoords(options: {
  query?: string;
  elementToken?: string;
  x?: number;
  y?: number;
  windowId?: number;
  pid?: number;
}): Promise<{ ok: boolean; message: string; x?: number; y?: number }> {
  const active = getActiveSurface();
  const windowId = options.windowId ?? active?.window_id;
  let pid = options.pid ?? active?.pid;

  if (!windowId) {
    return { ok: false, message: 'Tidak ada window_id aktif.' };
  }
  if (!pid) {
    const wins = await getConnectedWindows();
    pid = wins.find((w) => w.window_id === windowId)?.pid ?? 0;
  }

  // 1. Jika elementToken diberikan langsung, klik tanpa window_id (sesuai spesifikasi CUA MCP)
  if (options.elementToken && pid > 0) {
    if (options.x !== undefined && options.y !== undefined) {
      setCursorAction(windowId, Math.round(options.x), Math.round(options.y), true);
    }

    const axAttempt = await cuaCallToolDetailed('click', {
      pid,
      element_token: options.elementToken,
      delivery_mode: 'background',
    });

    if (!axAttempt.isError && axAttempt.effect !== 'suspected_noop' && axAttempt.effect !== 'refused') {
      bumpFrameVersion(windowId);
      return {
        ok: true,
        message: `Klik AX element_token (${options.elementToken}) berhasil: ${axAttempt.rawText}`,
      };
    }
    // ZERO INTRUSION: NEVER escalate to foreground
  }

  // 2. Jika ada query teks, cari dulu element_token di AX Tree CUA (Rung 1: paling akurat di background)
  if (options.query && pid > 0) {
    await ensureWindowSnapshot(pid, windowId, false);
    const qLower = options.query.toLowerCase();
    const matchedAx = lastSnapshotElements.find((el) => {
      const label = (el.label ?? '').toLowerCase();
      const title = (el.title ?? '').toLowerCase();
      const val = (el.value ?? '').toLowerCase();
      return (
        el.element_token &&
        (label.includes(qLower) || title.includes(qLower) || val.includes(qLower))
      );
    });

    if (matchedAx?.element_token) {
      if (matchedAx.bounds) {
        const cx = Math.round(matchedAx.bounds.x + matchedAx.bounds.width / 2);
        const cy = Math.round(matchedAx.bounds.y + matchedAx.bounds.height / 2);
        setCursorAction(windowId, cx, cy, true);
      } else if (options.x !== undefined && options.y !== undefined) {
        setCursorAction(windowId, Math.round(options.x), Math.round(options.y), true);
      }
      const axRes = await cuaCallWithBackgroundLadder('click', {
        pid,
        element_token: matchedAx.element_token,
        delivery_mode: 'background',
      });
      bumpFrameVersion(windowId);
      return {
        ok: true,
        message: `Klik AX element_token (${matchedAx.element_token}) untuk "${options.query}" berhasil: ${axRes}`,
      };
    }
  }

  // 3. Jika tidak ada element_token yang cocok, gunakan koordinat (x, y) atau visual grounding OCR/VLM
  if (options.x !== undefined && options.y !== undefined) {
    const clickRes = await cuaClick(options.x, options.y, windowId, pid, 'background');
    return {
      ok: true,
      message: `Klik koordinat (${options.x}, ${options.y}) berhasil: ${clickRes}`,
      x: Math.round(options.x),
      y: Math.round(options.y),
    };
  }

  if (options.query) {
    const obs = await perceptionObserveWorkspace({
      windowId,
      query: options.query,
      provider: 'hybrid',
      settleDelayMs: 200,
    });
    if (obs.elements.length === 0) {
      return { ok: false, message: `Teks "${options.query}" tidak ditemukan pada layar.` };
    }
    const target = obs.elements[0]!;
    const clickRes = await cuaClick(target.center_x, target.center_y, windowId, pid, 'background');
    return {
      ok: true,
      message: `Klik visual "${target.label}" pada (${target.center_x}, ${target.center_y}) berhasil: ${clickRes}`,
      x: Math.round(target.center_x),
      y: Math.round(target.center_y),
    };
  }

  return { ok: false, message: 'Parameter query atau (x, y) diperlukan.' };
}

export async function cuaGroundAndClick(
  query: string,
  windowId?: number,
): Promise<{ ok: boolean; message: string; x?: number; y?: number }> {
  return cuaClickElementOrCoords({ query, windowId });
}

export async function cuaTypeText(
  text: string,
  windowId?: number,
  pid?: number,
  coords?: { x: number; y: number },
  _deliveryMode: CuaDeliveryMode = 'background',
): Promise<string> {
  const active = getActiveSurface();
  const resolvedWindowId = windowId ?? active?.window_id;
  let resolvedPid =
    pid ?? (active && active.window_id === resolvedWindowId ? active.pid : active?.pid);

  if (!resolvedPid && resolvedWindowId) {
    const wins = await getConnectedWindows();
    resolvedPid = wins.find((w) => w.window_id === resolvedWindowId)?.pid;
  }

  if (resolvedWindowId && coords) {
    setCursorAction(resolvedWindowId, coords.x, coords.y, false, {
      phase: 'type',
      label: text.slice(0, 24),
    });
  }

  if (resolveBcuBaseUrl() && resolvedWindowId) {
    const bcuTarget = (await resolveBcuWindowId(resolvedWindowId, active?.app_name)) ?? String(resolvedWindowId);
    const bcuRes = await bcuCall('/v1/type_text', {
      window: bcuTarget,
      text,
      focusAssistMode: 'focus_and_caret_end',
      imageMode: 'path',
    });
    if (bcuRes.ok) {
      bumpFrameVersion(resolvedWindowId);
      return JSON.stringify(bcuRes.data);
    }
  }

  // 2. Fallback to CUA MCP daemon with delivery_mode: 'background'
  const payload: Record<string, unknown> = {
    text,
    window_id: resolvedWindowId,
    pid: resolvedPid,
    delivery_mode: 'background',
  };

  if (coords) {
    payload.x = coords.x;
    payload.y = coords.y;
  }

  const res = await cuaCallWithBackgroundLadder('type_text', payload);
  if (resolvedWindowId) {
    bumpFrameVersion(resolvedWindowId);
  }
  return res;
}

export async function cuaPressKey(
  key: string,
  windowId?: number,
  pid?: number,
  _deliveryMode: CuaDeliveryMode = 'background',
): Promise<string> {
  const active = getActiveSurface();
  const resolvedWindowId = windowId ?? active?.window_id;
  let resolvedPid =
    pid ?? (active && active.window_id === resolvedWindowId ? active.pid : active?.pid);

  if (!resolvedPid && resolvedWindowId) {
    const wins = await getConnectedWindows();
    resolvedPid = wins.find((w) => w.window_id === resolvedWindowId)?.pid;
  }

  if (resolveBcuBaseUrl() && resolvedWindowId) {
    const bcuTarget = (await resolveBcuWindowId(resolvedWindowId, active?.app_name)) ?? String(resolvedWindowId);
    const bcuRes = await bcuCall('/v1/press_key', {
      window: bcuTarget,
      key,
      imageMode: 'path',
    });
    if (bcuRes.ok) {
      bumpFrameVersion(resolvedWindowId);
      return JSON.stringify(bcuRes.data);
    }
  }
  // 2. Fallback to CUA MCP daemon with delivery_mode: 'background'
  const res = await cuaCallWithBackgroundLadder('press_key', {
    key,
    window_id: resolvedWindowId,
    pid: resolvedPid,
    delivery_mode: 'background',
  });

  if (resolvedWindowId) {
    bumpFrameVersion(resolvedWindowId);
  }
  return res;
}

export async function cuaHotkey(
  keys: string[],
  windowId?: number,
  pid?: number,
  _deliveryMode: CuaDeliveryMode = 'background',
): Promise<string> {
  const active = getActiveSurface();
  const resolvedWindowId = windowId ?? active?.window_id;
  let resolvedPid =
    pid ?? (active && active.window_id === resolvedWindowId ? active.pid : active?.pid);

  if (!resolvedPid && resolvedWindowId) {
    const wins = await getConnectedWindows();
    resolvedPid = wins.find((w) => w.window_id === resolvedWindowId)?.pid;
  }

  if (resolveBcuBaseUrl() && resolvedWindowId) {
    const bcuTarget = (await resolveBcuWindowId(resolvedWindowId, active?.app_name)) ?? String(resolvedWindowId);
    const keyCombination = keys.join('+');
    const bcuRes = await bcuCall('/v1/press_key', {
      window: bcuTarget,
      key: keyCombination,
      imageMode: 'path',
    });
    if (bcuRes.ok) {
      bumpFrameVersion(resolvedWindowId);
      return JSON.stringify(bcuRes.data);
    }
  }

  // 2. Fallback to CUA MCP daemon with delivery_mode: 'background'
  const res = await cuaCallWithBackgroundLadder('hotkey', {
    keys,
    window_id: resolvedWindowId,
    pid: resolvedPid,
    delivery_mode: 'background',
  });

  if (resolvedWindowId) {
    bumpFrameVersion(resolvedWindowId);
  }
  return res;
}

/**
 * Navigates browser URL in background via AppleScript without activating or stealing focus.
 */
export function cuaNavigateBrowserBackground(
  appName: string,
  targetUrl: string,
): { ok: boolean; message: string } {
  const safeUrl = targetUrl.startsWith('http://') || targetUrl.startsWith('https://')
    ? targetUrl
    : `https://${targetUrl}`;

  const lower = appName.toLowerCase();
  try {
    if (lower.includes('safari')) {
      // Background AppleScript without activating / stealing focus
      execSync(
        `osascript -e 'tell application "Safari" to set URL of current tab of front window to "${safeUrl}"'`,
        { timeout: 5000 },
      );
    } else {
      // Chromium browsers (Chrome, Brave, Edge, Arc)
      execSync(
        `osascript -e 'tell application "${appName}" to set URL of active tab of front window to "${safeUrl}"'`,
        { timeout: 5000 },
      );
    }
    bumpFrameVersion();
    return {
      ok: true,
      message: `Navigasi background ke ${safeUrl} di ${appName} berhasil tanpa mencuri fokus.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Gagal navigasi background di ${appName}: ${msg}` };
  }
}

export async function getConnectedWindows(): Promise<ConnectedWindow[]> {
  const combined: ConnectedWindow[] = [];

  try {
    const res = await fetch(CUA_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: 'list_windows', arguments: {} },
      }),
    });
    const json = (await res.json()) as {
      result?: {
        structuredContent?: {
          windows?: Array<{
            window_id: number;
            pid: number;
            app_name: string;
            title?: string;
            bounds?: { width: number; height: number };
          }>;
        };
      };
    };
    const all = json.result?.structuredContent?.windows ?? [];
    const ignoredApps = new Set([
      'izabot',
      'app',
      'Window Server',
      'CursorUIViewService',
      'loginwindow',
      'AutoFill',
      'ShareSheetUI',
      'Open and Save Panel Service',
    ]);
    const mapped = all
      .filter(
        (w) =>
          (w.bounds?.width ?? 0) > 300 &&
          (w.bounds?.height ?? 0) > 200 &&
          !ignoredApps.has(w.app_name),
      )
      .map((w) => ({
        window_id: w.window_id,
        pid: w.pid,
        app_name: w.app_name.replaceAll('\u200E', ''),
        title: (w.title || w.app_name).replaceAll('\u200E', ''),
        width: w.bounds?.width ?? 800,
        height: w.bounds?.height ?? 600,
      }));
    combined.push(...mapped);
  } catch {}

  const localWindows = runPerceptionListWindows();
  for (const lw of localWindows) {
    const exists = combined.some((c) => c.window_id === lw.window_id);
    if (!exists) {
      combined.push(lw);
    }
  }

  return combined;
}

export async function captureLiveWindowFrameAsync(windowId: number): Promise<Buffer | null> {
  const memoryBuf = getLatestMemoryFrame(windowId, 2000);
  if (memoryBuf && memoryBuf.length > 0) {
    return memoryBuf;
  }
  return null;
}

export function captureWindowImage(windowId: number): Buffer | null {
  const memoryBuf = getLatestMemoryFrame(windowId, 2000);
  if (memoryBuf && memoryBuf.length > 0) {
    return memoryBuf;
  }
  return null;
}

/**
 * Universal Action Dispatcher: Grounding target visually via Perception Eye
 * and dynamically sending text and Enter keystrokes to connected windows.
 * Implements WhatsApp 3-Stage Visual Reply Flow via True Background CUA.
 */
export async function cuaSendInputToWindow(
  options: SendInputOptions,
): Promise<string> {
  let { windowId, pid, appName, text, submitWithEnter = true } = options;

  const activeSurface = getActiveSurface();
  if (activeSurface) {
    if (
      appName &&
      !appName.toLowerCase().includes(activeSurface.app_name.toLowerCase()) &&
      !activeSurface.app_name.toLowerCase().includes(appName.toLowerCase())
    ) {
      return `Aksi ditolak (Strict Scoped Policy): Aplikasi "${appName}" tidak sedang aktif di panel workspace kanan. Sesi ini dikunci khusus pada "${activeSurface.app_name}".`;
    }
    windowId = activeSurface.window_id;
    pid = activeSurface.pid;
    appName = activeSurface.app_name;
  }

  const windows = await getConnectedWindows();
  let targetWin = windows.find((w) => w.window_id === windowId);

  if (!targetWin && activeSurface) {
    targetWin = {
      window_id: activeSurface.window_id,
      pid: activeSurface.pid,
      app_name: activeSurface.app_name,
      title: activeSurface.title,
      width: activeSurface.width,
      height: activeSurface.height,
    };
  }

  if (!targetWin) {
    return 'Tidak ada jendela aplikasi yang terhubung untuk dikirimi input.';
  }

  windowId = targetWin.window_id;
  pid = targetWin.pid;
  appName = targetWin.app_name;

  // TAHAP 1: Grounding & Klik Kontak Target di Chat List
  if (options.contactOrRecipient && windowId) {
    await cuaClickElementOrCoords({
      query: options.contactOrRecipient,
      windowId,
      pid,
    });
    await new Promise((r) => setTimeout(r, 400));
  }

  // TAHAP 2: Temukan & Klik Kotak Input Pesan WhatsApp
  const winWidth = targetWin.width || 1512;
  const winHeight = targetWin.height || 873;
  let composerX = Math.round(winWidth * 0.65);
  let composerY = winHeight - 35;

  const inputObserve = await perceptionObserveWorkspace({
    windowId,
    provider: 'apple_vision',
    settleDelayMs: 150,
  });

  const composerElement = inputObserve.elements.find((e) => {
    const isAtBottom = e.center_y > winHeight * 0.88;
    const isInRightPane = e.center_x > winWidth * 0.35;
    const labelLower = e.label.toLowerCase();
    const isComposerPlaceholder =
      labelLower.includes('pesan') ||
      labelLower.includes('type') ||
      labelLower.includes('message') ||
      labelLower.includes('ketik');
    return isAtBottom && isInRightPane && isComposerPlaceholder;
  });

  if (composerElement) {
    composerX = Math.round(composerElement.center_x);
    composerY = Math.round(composerElement.center_y);
  }

  await cuaClick(composerX, composerY, windowId, pid, 'background');
  await new Promise((r) => setTimeout(r, 250));

  // TAHAP 3: Kirim Teks dan Tekan Enter
  await cuaTypeText(text, windowId, pid, { x: composerX, y: composerY }, 'background');
  await new Promise((r) => setTimeout(r, 150));

  if (submitWithEnter) {
    await cuaPressKey('Return', windowId, pid, 'background');
    await new Promise((r) => setTimeout(r, 300));
  }

  return `Pesan "${text}" berhasil dikirim ke ${options.contactOrRecipient ? `**${options.contactOrRecipient}** di ` : ''}**${appName}** via 3-Stage Visual Grounding (Background CUA).`;
}
