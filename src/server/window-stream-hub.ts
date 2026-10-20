// SPDX-License-Identifier: MIT
// Real-time In-Memory Window Streaming Hub via ScreenCaptureKit & Binary WebSocket

import { spawn, type ChildProcess } from 'node:child_process';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  setCursorBroadcaster,
  getActiveSurface,
  setActiveSurface,
} from './active-surface.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { runPerceptionListWindows } from './perception-engine.js';
import { consumeStreamTicket } from './stream-tickets.js';

interface StreamSession {
  windowId: number;
  proc: ChildProcess | null;
  clients: Set<WebSocket>;
  latestBuffer: Buffer | null;
  lastFrameAt: number;
  lastStreamStdoutAt: number;
  consecutiveFailures: number;
  isCapturingFallback: boolean;
  idleTimer: NodeJS.Timeout | null;
}

const activeSessions = new Map<number, StreamSession>();

function resolveStreamerBinary(): string {
  const override = process.env.PERCEPTION_BIN_PATH;
  if (override && existsSync(override)) return override;
  const localBin = path.resolve(process.cwd(), 'bin/perception-eye');
  if (existsSync(localBin)) return localBin;
  return 'perception-eye';
}

function startStreamerProcess(session: StreamSession): void {
  if (session.proc) return;

  const binPath = resolveStreamerBinary();
  const proc = spawn(
    binPath,
    ['stream-window', String(session.windowId), '30', '1280'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  session.proc = proc;

  let bufferAccumulator = Buffer.alloc(0);

  proc.stdout.on('data', (chunk: Buffer) => {
    bufferAccumulator = Buffer.concat([bufferAccumulator, chunk]);

    while (bufferAccumulator.length >= 4) {
      const frameLength = bufferAccumulator.readUInt32BE(0);
      if (bufferAccumulator.length < 4 + frameLength) {
        break; // Wait for full frame bytes to arrive
      }

      const jpegData = bufferAccumulator.subarray(4, 4 + frameLength);
      bufferAccumulator = bufferAccumulator.subarray(4 + frameLength);

      session.latestBuffer = jpegData;
      session.lastFrameAt = Date.now();
      session.lastStreamStdoutAt = Date.now();
      session.consecutiveFailures = 0;

      // Broadcast binary frame to all connected clients
      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(jpegData);
          } catch {}
        }
      }
    }
  });

  proc.stderr.on('data', (errChunk: Buffer) => {
    const msg = errChunk.toString().trim();
    if (msg.length > 0) {
      console.warn(`[WindowStreamer stderr ${session.windowId}]:`, msg);
    }
  });

  proc.on('close', (code) => {
    session.proc = null;
    if (session.clients.size > 0) {
      // Auto-restart if clients are still connected
      setTimeout(() => {
        if (session.clients.size > 0 && !session.proc) {
          startStreamerProcess(session);
        }
      }, 500);
    }
  });
}

export function getLatestMemoryFrame(
  windowId: number,
  maxAgeMs = 250,
): Buffer | null {
  const session = activeSessions.get(windowId);
  if (!session || !session.latestBuffer) return null;
  if (Date.now() - session.lastFrameAt > maxAgeMs) {
    return null; // Frame stale (> 250ms), force live capture
  }
  return session.latestBuffer;
}

export function broadcastCursorTelemetry(
  _windowId: number,
  payload: unknown,
): void {
  const message = JSON.stringify({ type: 'cursor', data: payload });
  for (const session of activeSessions.values()) {
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch {}
      }
    }
  }
}

export function setupWebSocketStreaming(httpServer: HttpServer): void {
  setCursorBroadcaster(broadcastCursorTelemetry);
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(
      request.url ?? '',
      `http://${request.headers.host ?? 'localhost'}`,
    );
    const match = url.pathname.match(/^\/api\/connected-apps\/stream\/(\d+)$/);

    if (!match) {
      return;
    }

    const windowId = parseInt(match[1]!, 10);
    if (!windowId || isNaN(windowId)) {
      socket.destroy();
      return;
    }

    const ticket = url.searchParams.get('ticket') ?? '';
    if (!consumeStreamTicket(ticket, windowId)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, windowId);
    });
  });

  wss.on(
    'connection',
    (ws: WebSocket, _request: IncomingMessage, windowId: number) => {
      let session = activeSessions.get(windowId);
      if (!session) {
        session = {
          windowId,
          proc: null,
          clients: new Set(),
          latestBuffer: null,
          lastFrameAt: 0,
          lastStreamStdoutAt: 0,
          consecutiveFailures: 0,
          isCapturingFallback: false,
          idleTimer: null,
        };
        activeSessions.set(windowId, session);
      }

      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }

      session.clients.add(ws);

      // Send immediate cached RAM frame if available
      const initialBuf =
        session.latestBuffer ?? getLatestMemoryFrame(windowId, 5000);
      if (
        initialBuf &&
        initialBuf.length > 0 &&
        ws.readyState === WebSocket.OPEN
      ) {
        try {
          ws.send(initialBuf);
        } catch {}
      }

      // Ensure native ScreenCaptureKit streamer is running
      startStreamerProcess(session);
      ws.on('close', () => {
        session?.clients.delete(ws);
        if (session && session.clients.size === 0) {
          // Keep streamer alive for 15s in case of page reload, then kill to free GPU/CPU
          session.idleTimer = setTimeout(() => {
            if (session.clients.size === 0 && session.proc) {
              try {
                session.proc.kill('SIGTERM');
              } catch {}
              session.proc = null;
              activeSessions.delete(windowId);
            }
          }, 15000);
        }
      });

      ws.on('error', () => {
        session?.clients.delete(ws);
      });
    },
  );
}
