// SPDX-License-Identifier: MIT
// Connected Mac App Workspace — Conforming strictly to DESIGN.md Section 5.D & 5.E

import { useState, useEffect, useRef, useCallback } from 'react';
import { RealtimeWindowCanvas } from './RealtimeWindowCanvas.js';
import {
  AppWindow,
  RefreshCw,
  X,
  ChevronDown,
  Lock,
  Crosshair,
  ScanEye,
  PenLine,
  Command,
  Navigation,
} from 'lucide-react';

export interface ConnectedWindow {
  window_id: number;
  pid: number;
  app_name: string;
  title: string;
  width: number;
  height: number;
}

export type AgentCursorPhase =
  'idle' | 'observe' | 'move' | 'click' | 'type' | 'hotkey';

export interface CursorTelemetryPayload {
  seq: number;
  window_id: number;
  x: number;
  y: number;
  from_norm_x?: number;
  from_norm_y?: number;
  norm_x: number;
  norm_y: number;
  phase: AgentCursorPhase;
  label?: string;
  is_clicking: boolean;
  duration_ms?: number;
}

export function WorkspaceAgentCursor({
  telemetry,
  canvasRef,
}: {
  telemetry: CursorTelemetryPayload | null;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
  const cursorRootRef = useRef<HTMLDivElement | null>(null);
  const posRef = useRef<{ x: number; y: number }>({ x: 180, y: 140 });
  const animFrameRef = useRef<number | null>(null);
  const [rippleKey, setRippleKey] = useState<number>(0);

  useEffect(() => {
    if (!telemetry || !cursorRootRef.current) return;
    const targetEl = canvasRef.current ?? cursorRootRef.current.parentElement;
    if (!targetEl) return;
    const rect = targetEl.getBoundingClientRect();
    const width = rect.width > 20 ? rect.width : 440;
    const height = rect.height > 20 ? rect.height : 300;

    const normX = Math.max(0.02, Math.min(0.98, telemetry.norm_x ?? 0.5));
    const normY = Math.max(0.02, Math.min(0.98, telemetry.norm_y ?? 0.5));
    const targetX = normX * width;
    const targetY = normY * height;

    const startX = posRef.current.x;
    const startY = posRef.current.y;
    const dx = targetX - startX;
    const dy = targetY - startY;
    const distNorm = Math.hypot(dx / width, dy / height);
    const duration =
      telemetry.duration_ms ??
      Math.min(
        340,
        Math.max(120, Math.round(110 + 220 * Math.log2(1 + distNorm / 0.04))),
      );

    if (telemetry.is_clicking || telemetry.phase === 'click') {
      setRippleKey((prev) => prev + 1);
    }

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    if (
      (telemetry.duration_ms !== undefined && telemetry.duration_ms <= 0) ||
      distNorm < 0.003
    ) {
      posRef.current = { x: targetX, y: targetY };
      cursorRootRef.current.style.transform = `translate3d(${targetX.toFixed(1)}px, ${targetY.toFixed(1)}px, 0)`;
      return;
    }

    const startTime = performance.now();
    const arcCurvature = 0.035;

    const step = (now: number) => {
      const tau = Math.min(1, Math.max(0, (now - startTime) / duration));
      const s = tau * tau * tau * (10 + tau * (-15 + 6 * tau));
      const bow = 4 * tau * (1 - tau) * arcCurvature;

      const curX = startX + dx * s - dy * bow;
      const curY = startY + dy * s + dx * bow;

      posRef.current = { x: curX, y: curY };
      if (cursorRootRef.current) {
        cursorRootRef.current.style.transform = `translate3d(${curX.toFixed(1)}px, ${curY.toFixed(1)}px, 0)`;
      }

      if (tau < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      }
    };

    animFrameRef.current = requestAnimationFrame(step);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [
    telemetry?.seq,
    telemetry?.norm_x,
    telemetry?.norm_y,
    telemetry?.phase,
    canvasRef,
  ]);

  const phase = telemetry?.phase || (telemetry?.is_clicking ? 'click' : 'idle');
  const isPressed = telemetry?.is_clicking || phase === 'click';

  const renderPhaseIcon = () => {
    switch (phase) {
      case 'observe':
        return <ScanEye size={11} />;
      case 'click':
        return <Crosshair size={11} />;
      case 'type':
        return <PenLine size={11} />;
      case 'hotkey':
        return <Command size={11} />;
      default:
        return <Navigation size={11} />;
    }
  };

  const renderPhaseText = () => {
    if (phase === 'type' && telemetry?.label)
      return `Typing "${telemetry.label}"`;
    if (phase === 'hotkey' && telemetry?.label) return telemetry.label;
    if (phase === 'observe') return 'Observing the screen…';
    if (phase === 'click')
      return telemetry?.label ? `Click ${telemetry.label}` : 'Clicking';
    return telemetry?.label || 'OpenDots Agent';
  };

  return (
    <div
      ref={cursorRootRef}
      className={`canvas-virtual-cursor phase-${phase} ${isPressed ? 'is-clicking' : ''}`}
      style={{
        left: 0,
        top: 0,
        transform: `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0)`,
      }}
    >
      {rippleKey > 0 && (
        <span
          key={rippleKey}
          className="cursor-ripple-group"
          aria-hidden="true"
        >
          <span className="cursor-ripple-ring primary-ring" />
          <span className="cursor-ripple-ring secondary-ring" />
        </span>
      )}

      <div className="cursor-pointer-body">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          className="cursor-pointer-svg"
        >
          <path
            d="M4.2 3.4L19.6 10.1C20.5 10.5 20.4 11.8 19.5 12.1L13.1 14.1L10.3 20.2C9.9 21.1 8.6 21.0 8.3 20.1L3.0 4.6C2.7 3.8 3.5 3.1 4.2 3.4Z"
            fill="#0095a1"
            stroke="#ffffff"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div className="cursor-state-pill">
        <span className="cursor-pill-icon">{renderPhaseIcon()}</span>
        <span className="cursor-pill-label">{renderPhaseText()}</span>
      </div>
    </div>
  );
}

export function ConnectedAppWorkspace({
  onClose,
  boundApps = [],
}: {
  onClose: () => void;
  boundApps?: string[];
}) {
  const [windows, setWindows] = useState<ConnectedWindow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [timestamp, setTimestamp] = useState<number>(Date.now());
  const [loading, setLoading] = useState<boolean>(false);
  const [telemetry, setTelemetry] = useState<CursorTelemetryPayload | null>({
    seq: 1,
    window_id: 0,
    x: 200,
    y: 150,
    norm_x: 0.2,
    norm_y: 0.2,
    phase: 'idle',
    label: 'OpenDots Agent',
    is_clicking: false,
  });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastFrameVersion = useRef<number>(1);
  const boundKey = boundApps.map((app) => app.toLowerCase()).join('\u0000');
  const boundSet = new Set(boundKey.split('\u0000').filter(Boolean));
  const orderedWindows = [
    ...windows.filter((win) => boundSet.has(win.app_name.toLowerCase())),
    ...windows.filter((win) => !boundSet.has(win.app_name.toLowerCase())),
  ];
  const [takeover, setTakeover] = useState<{
    active: boolean;
    reason?: string;
  } | null>(null);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/connected-apps/takeover/status');
        if (res.ok) {
          const data = (await res.json()) as {
            active: boolean;
            reason?: string;
          };
          setTakeover(data);
        }
      } catch {}
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleTakeoverActivate = async () => {
    try {
      await fetch('/api/connected-apps/takeover/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {}
  };

  const handleTakeoverResume = async () => {
    try {
      await fetch('/api/connected-apps/takeover/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      setTakeover({ active: false });
    } catch {}
  };
  const fetchWindows = useCallback(async () => {
    try {
      const res = await fetch('/api/connected-apps/windows');
      if (!res.ok) return;
      const list = (await res.json()) as ConnectedWindow[];
      setWindows(list);
      const bound = new Set(boundKey.split('\u0000').filter(Boolean));

      // Synchronize with active surface state from server
      try {
        const surfRes = await fetch('/api/connected-apps/active-surface');
        if (surfRes.ok) {
          const surf = (await surfRes.json()) as { window_id?: number };
          if (surf && typeof surf.window_id === 'number') {
            const match = list.find((w) => w.window_id === surf.window_id);
            if (match) {
              setSelectedId(match.window_id);
              return;
            }
          }
        }
      } catch {}

      if (list.length > 0 && selectedId === null) {
        const preferred =
          list.find((w) => bound.has(w.app_name.toLowerCase())) ??
          list.find((w) => w.app_name.toLowerCase().includes('whatsapp')) ??
          list.find((w) => w.app_name.toLowerCase().includes('safari')) ??
          list[0];
        if (preferred) setSelectedId(preferred.window_id);
      }
    } catch {
      // Ignore poll error
    }
  }, [selectedId, boundKey]);

  useEffect(() => {
    void fetchWindows();
  }, [fetchWindows]);

  const refreshFrame = useCallback(() => {
    setLoading(true);
    setTimestamp(Date.now());
  }, []);

  const selectedWin =
    orderedWindows.find((w) => w.window_id === selectedId) ?? orderedWindows[0];

  const syncActiveSurface = useCallback(async (win: ConnectedWindow) => {
    try {
      await fetch('/api/connected-apps/active-surface', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(win),
      });
    } catch {
      // Handled
    }
  }, []);

  useEffect(() => {
    if (selectedWin) {
      void syncActiveSurface(selectedWin);
    }
  }, [selectedWin, syncActiveSurface]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch('/api/connected-apps/cursor');
        if (!res.ok || !active) return;
        const cur = (await res.json()) as CursorTelemetryPayload | null;
        if (
          cur &&
          typeof cur.seq === 'number' &&
          typeof cur.norm_x === 'number'
        ) {
          setTelemetry((prev) => (!prev || cur.seq !== prev.seq ? cur : prev));
        }
      } catch {}
    })();
    return () => {
      active = false;
    };
  }, []);
  const handleCanvasClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current || !selectedWin) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = selectedWin.width / rect.width;
    const scaleY = selectedWin.height / rect.height;

    const clickX = Math.round((e.clientX - rect.left) * scaleX);
    const clickY = Math.round((e.clientY - rect.top) * scaleY);

    setTelemetry({
      seq: Date.now(),
      window_id: selectedWin.window_id,
      x: clickX,
      y: clickY,
      norm_x: clickX / selectedWin.width,
      norm_y: clickY / selectedWin.height,
      phase: 'click',
      label: 'You',
      is_clicking: true,
    });

    try {
      await fetch('/api/connected-apps/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x: clickX,
          y: clickY,
          window_id: selectedWin.window_id,
        }),
      });
      setTimeout(refreshFrame, 350);
    } catch {
      // Handled
    }
  };

  return (
    <aside
      className="result-pane workspace-canvas-panel"
      aria-label="Connected application workspace"
    >
      <div className="pane-header workspace-pane-header">
        <div className="workspace-header-title">
          <span className="workspace-surface-icon">
            <AppWindow size={15} />
          </span>
          <div>
            <span className="eyebrow">SCOPED WORKSPACE</span>
            <strong>{selectedWin?.app_name ?? 'Mac Application'}</strong>
          </div>
        </div>

        <div className="workspace-header-controls">
          {windows.length > 0 && (
            <div className="app-select-wrapper">
              <select
                className="app-select"
                value={selectedWin?.window_id ?? ''}
                onChange={(e) => {
                  setSelectedId(Number(e.target.value));
                  refreshFrame();
                }}
                aria-label="Choose a connected app"
              >
                {orderedWindows.filter((win) =>
                  boundSet.has(win.app_name.toLowerCase()),
                ).length > 0 && (
                  <optgroup label="Bound to this Space">
                    {orderedWindows
                      .filter((win) => boundSet.has(win.app_name.toLowerCase()))
                      .map((win) => (
                        <option key={win.window_id} value={win.window_id}>
                          {win.app_name}
                        </option>
                      ))}
                  </optgroup>
                )}
                {orderedWindows.filter(
                  (win) => !boundSet.has(win.app_name.toLowerCase()),
                ).length > 0 && (
                  <optgroup label="Other windows">
                    {orderedWindows
                      .filter(
                        (win) => !boundSet.has(win.app_name.toLowerCase()),
                      )
                      .map((win) => (
                        <option key={win.window_id} value={win.window_id}>
                          {win.app_name}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
              <ChevronDown size={12} className="select-arrow" />
            </div>
          )}

          <button
            type="button"
            className="icon-button"
            onClick={() => {
              void fetchWindows();
              refreshFrame();
            }}
            title="Refresh window frame"
            aria-label="Refresh window frame"
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>

          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            title="Close workspace"
            aria-label="Close workspace"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="computer-view workspace-computer-view">
        {selectedWin ? (
          <>
            <div className="browser-bar workspace-browser-bar">
              <div className="window-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <span className="browser-bar-title" title={selectedWin.title}>
                {selectedWin.title || selectedWin.app_name}
              </span>
              <div className="browser-bar-meta">
                <span className="mode-badge live">
                  <span className="online-dot-inline" />
                  REALTIME GPU (SCSTREAM)
                </span>
                <span className="dimension-pill">
                  {selectedWin.width} x {selectedWin.height}
                </span>
              </div>
            </div>

            {takeover?.active && (
              <div className="takeover-alert-banner">
                <div className="takeover-info">
                  <strong>Manual takeover needed:</strong>
                  <span>
                    {takeover.reason ||
                      'Confirm the required action in the target app.'}
                  </span>
                </div>
                <div className="takeover-actions">
                  <button
                    type="button"
                    className="takeover-btn-front"
                    onClick={handleTakeoverActivate}
                  >
                    Bring the app to the front
                  </button>
                  <button
                    type="button"
                    className="takeover-btn-resume"
                    onClick={handleTakeoverResume}
                  >
                    I&apos;m done, resume automation
                  </button>
                </div>
              </div>
            )}
            <div
              className="canvas-viewport-frame"
              onClick={handleCanvasClick}
              role="button"
              tabIndex={0}
              aria-label={`Interactive canvas for ${selectedWin.app_name}`}
            >
              <div className="canvas-image-stage">
                <RealtimeWindowCanvas
                  windowId={selectedWin.window_id}
                  logicalWidth={selectedWin.width}
                  logicalHeight={selectedWin.height}
                  onCanvasReady={(canvas) => {
                    canvasRef.current = canvas;
                  }}
                  onCursorTelemetry={(data) => {
                    if (data && typeof data === 'object') {
                      setTelemetry(data as CursorTelemetryPayload);
                    }
                  }}
                />
                <WorkspaceAgentCursor
                  telemetry={telemetry}
                  canvasRef={canvasRef}
                />
              </div>
            </div>

            <div className="workspace-scope-bar">
              <div className="scope-bar-left">
                <Lock size={12} />
                <span>
                  Locked to <strong>{selectedWin.app_name}</strong> (Window #
                  {selectedWin.window_id}) — keep the window open behind
                  OpenDots
                </span>
              </div>
              <small>
                {boundSet.has(selectedWin.app_name.toLowerCase())
                  ? 'Bound to this Space · Background CUA'
                  : 'Background CUA'}
              </small>
            </div>
          </>
        ) : (
          <div className="pane-empty">
            <AppWindow size={28} />
            <h3>No active app windows.</h3>
            <p>
              Open a target app (such as WhatsApp or Safari) on macOS and keep
              its window out of the Dock.
            </p>
            <button type="button" onClick={() => void fetchWindows()}>
              Scan again
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
