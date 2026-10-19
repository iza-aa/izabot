// SPDX-License-Identifier: MIT
// Active Workspace Surface State Store & Virtual Canvas Cursor Telemetry

export type SurfaceKind = 'native_app' | 'web_browser';
export type CursorPhase = 'idle' | 'move' | 'click' | 'type' | 'hotkey';

export interface ActiveSurface {
  window_id: number;
  pid: number;
  app_name: string;
  surface_kind: SurfaceKind;
  title: string;
  width: number;
  height: number;
  updated_at: number;
  frame_version: number;
}

export interface CursorAction {
  seq: number;
  window_id: number;
  x: number;
  y: number;
  from_norm_x?: number;
  from_norm_y?: number;
  norm_x: number;
  norm_y: number;
  phase: CursorPhase;
  label?: string;
  is_clicking: boolean;
  duration_ms?: number;
  frame_version: number;
  timestamp: number;
}

let cursorBroadcaster: ((windowId: number, payload: unknown) => void) | null = null;

export function setCursorBroadcaster(fn: (windowId: number, payload: unknown) => void): void {
  cursorBroadcaster = fn;
}

let currentSurface: ActiveSurface | null = null;
let lastCursorAction: CursorAction | null = null;
let cursorSeq = 0;
let frameVersion = 1;
const lastCapturedFramePath = new Map<number, { path: string; timestamp: number }>();

const BROWSER_KEYWORDS = ['safari', 'chrome', 'brave', 'arc', 'firefox', 'edge'];

export function detectSurfaceKind(appName: string): SurfaceKind {
  const lower = appName.toLowerCase();
  return BROWSER_KEYWORDS.some((b) => lower.includes(b)) ? 'web_browser' : 'native_app';
}

export function bumpFrameVersion(windowId?: number, imagePath?: string): number {
  frameVersion += 1;
  if (windowId && imagePath) {
    lastCapturedFramePath.set(windowId, { path: imagePath, timestamp: Date.now() });
  }
  if (currentSurface && (!windowId || currentSurface.window_id === windowId)) {
    currentSurface.frame_version = frameVersion;
    currentSurface.updated_at = Date.now();
  }
  return frameVersion;
}

export function getLatestFramePath(windowId: number, maxAgeMs = 250): string | undefined {
  const entry = lastCapturedFramePath.get(windowId);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > maxAgeMs) {
    lastCapturedFramePath.delete(windowId);
    return undefined;
  }
  return entry.path;
}

export function setActiveSurface(
  surface: Omit<ActiveSurface, 'surface_kind' | 'frame_version'> &
    Partial<Pick<ActiveSurface, 'surface_kind' | 'frame_version'>>,
): void {
  if (currentSurface?.window_id !== surface.window_id) {
    lastCursorAction = null;
  }
  frameVersion += 1;
  currentSurface = {
    ...surface,
    surface_kind: surface.surface_kind ?? detectSurfaceKind(surface.app_name),
    frame_version: surface.frame_version ?? frameVersion,
    updated_at: Date.now(),
  };
}

export function getActiveSurface(): ActiveSurface | null {
  return currentSurface;
}

export function setCursorAction(
  windowId: number,
  x: number,
  y: number,
  isClicking: boolean = false,
  options?: { phase?: CursorPhase; label?: string; duration_ms?: number },
): void {
  cursorSeq += 1;
  const width =
    currentSurface?.window_id === windowId && currentSurface.width > 0
      ? currentSurface.width
      : 1280;
  const height =
    currentSurface?.window_id === windowId && currentSurface.height > 0
      ? currentSurface.height
      : 800;

  const normX = Math.max(0, Math.min(1, x / width));
  const normY = Math.max(0, Math.min(1, y / height));
  const prevNormX = lastCursorAction?.norm_x ?? normX;
  const prevNormY = lastCursorAction?.norm_y ?? normY;

  lastCursorAction = {
    seq: cursorSeq,
    window_id: windowId,
    x: Math.round(x),
    y: Math.round(y),
    from_norm_x: prevNormX,
    from_norm_y: prevNormY,
    norm_x: Number(normX.toFixed(4)),
    norm_y: Number(normY.toFixed(4)),
    phase: options?.phase ?? (isClicking ? 'click' : 'move'),
    label: options?.label,
    is_clicking: isClicking,
    duration_ms: options?.duration_ms,
    frame_version: frameVersion,
    timestamp: Date.now(),
  };

  try {
    cursorBroadcaster?.(windowId, lastCursorAction);
  } catch {}
}

export function getCursorAction(): CursorAction | null {
  return lastCursorAction;
}

export function clearCursorAction(): void {
  lastCursorAction = null;
}
