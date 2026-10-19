// SPDX-License-Identifier: MIT
// High-performance real-time window canvas receiving binary JPEG frames via WebSocket

import { useEffect, useRef } from 'react';

interface RealtimeWindowCanvasProps {
  windowId: number;
  logicalWidth: number;
  logicalHeight: number;
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
  onCursorTelemetry?: (telemetry: unknown) => void;
  className?: string;
}

export function RealtimeWindowCanvas({
  windowId,
  logicalWidth,
  logicalHeight,
  onCanvasReady,
  onCursorTelemetry,
  className = 'canvas-live-image',
}: RealtimeWindowCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onReadyRef = useRef(onCanvasReady);
  const onTelemetryRef = useRef(onCursorTelemetry);

  useEffect(() => {
    onReadyRef.current = onCanvasReady;
    onTelemetryRef.current = onCursorTelemetry;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onReadyRef.current?.(canvas);

    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true, // Bypass DOM compositor queue for <10ms latency
    });
    if (!ctx) return;
    let active = true;
    let rendering = false;
    let pendingBuffer: ArrayBuffer | null = null;

    // 1. Instantly paint the initial frame from HTTP capture endpoint so the canvas is NEVER blank
    const initImg = new Image();
    initImg.src = `/api/connected-apps/capture/${windowId}?t=${Date.now()}`;
    initImg.onload = () => {
      if (!active) return;
      if (initImg.naturalWidth > 0 && initImg.naturalHeight > 0) {
        if (canvas.width !== initImg.naturalWidth || canvas.height !== initImg.naturalHeight) {
          canvas.width = initImg.naturalWidth;
          canvas.height = initImg.naturalHeight;
        }
        ctx.drawImage(initImg, 0, 0);
      }
    };

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${proto}//${location.host}/api/connected-apps/stream/${windowId}`,
    );
    ws.binaryType = 'arraybuffer';

    const renderNextFrame = async () => {
      if (rendering || !pendingBuffer || !active) return;
      rendering = true;
      const bufferToDraw = pendingBuffer;
      pendingBuffer = null;

      try {
        const blob = new Blob([bufferToDraw], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        if (active) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          ctx.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
      } catch {
        // Discard frame on window resize transition
      } finally {
        rendering = false;
        if (pendingBuffer && active) {
          requestAnimationFrame(() => void renderNextFrame());
        }
      }
    };

    ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === 'string') {
        try {
          const parsed = JSON.parse(event.data) as { type?: string; data?: unknown };
          if (parsed.type === 'cursor' && parsed.data) {
            onTelemetryRef.current?.(parsed.data);
          }
        } catch {}
        return;
      }

      if (!(event.data instanceof ArrayBuffer)) return;
      pendingBuffer = event.data;
      if (!rendering) {
        requestAnimationFrame(() => void renderNextFrame());
      }
    };

    return () => {
      active = false;
      try {
        ws.close();
      } catch {}
    };
  }, [windowId]);

  return (
    <canvas
      ref={canvasRef}
      width={logicalWidth}
      height={logicalHeight}
      className={className}
      style={{
        display: 'block',
        maxWidth: '100%',
        maxHeight: 'calc(100vh - 265px)',
        width: 'auto',
        height: 'auto',
        objectFit: 'contain',
        userSelect: 'none',
      }}
    />
  );
}
