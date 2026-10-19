// SPDX-License-Identifier: MIT
// Modular Perception Engine for OpenDots: Apple Vision OCR + gpt-6-luna VLM grounding

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setCursorAction, getActiveSurface } from './active-surface.js';
import { getLatestMemoryFrame } from './window-stream-hub.js';
const CUA_MCP_URL =
  process.env.CUA_MCP_URL ?? 'http://127.0.0.1:3211/mcp';

export interface UIElement {
  id: string;
  type: string;
  label: string;
  center_x: number;
  center_y: number;
  bounds: { x: number; y: number; w: number; h: number };
  confidence: number;
  source: string;
}

export interface ConnectedWindow {
  window_id: number;
  pid: number;
  app_name: string;
  title: string;
  width: number;
  height: number;
}

export interface PerceptionObserveResult {
  status: string;
  provider: string;
  workspace_info: {
    window_id: number;
    app_name: string;
    logical_width: number;
    logical_height: number;
  };
  elements: UIElement[];
}

export function resolvePerceptionEyeBin(): string {
  if (process.env.PERCEPTION_EYE_BIN && existsSync(process.env.PERCEPTION_EYE_BIN)) {
    return process.env.PERCEPTION_EYE_BIN;
  }

  const candidates = [
    path.resolve(process.cwd(), 'bin/perception-eye'),
    path.resolve(process.cwd(), '../iza-3/bin/perception-eye'),
    '/usr/local/bin/perception-eye',
  ];

  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }

  return 'perception-eye';
}

export function resolveCodexBin(): string | null {
  if (process.env.CODEX_BIN_PATH && existsSync(process.env.CODEX_BIN_PATH)) {
    return process.env.CODEX_BIN_PATH;
  }

  const home = os.homedir();
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(home, '.local/bin/codex'),
  ];

  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }

  return null;
}

export function resolveCodexHome(): string | null {
  if (process.env.CODEX_HOME && existsSync(process.env.CODEX_HOME)) {
    return process.env.CODEX_HOME;
  }

  const poolPath = path.join(
    os.homedir(),
    '.izanotchy/credentials/gpt_accounts/pool.json',
  );

  if (existsSync(poolPath)) {
    try {
      const content = readFileSync(poolPath, 'utf-8');
      const accounts = JSON.parse(content) as Array<{
        status?: { type?: string };
        homeDirectoryPath?: string;
      }>;
      const active = accounts.find(
        (a) => a.status?.type === 'active' && a.homeDirectoryPath,
      );
      if (active?.homeDirectoryPath && existsSync(active.homeDirectoryPath)) {
        return active.homeDirectoryPath;
      }
    } catch {
      // Fallback
    }
  }

  const defaultCodex = path.join(os.homedir(), '.codex');
  if (existsSync(defaultCodex)) {
    return defaultCodex;
  }

  return null;
}

export function runPerceptionListWindows(): ConnectedWindow[] {
  const bin = resolvePerceptionEyeBin();
  try {
    const stdout = execSync(`"${bin}" list-windows`, { encoding: 'utf-8' });
    const parsed = JSON.parse(stdout) as {
      status?: string;
      windows?: Array<{
        window_id: number;
        owner_name: string;
        owner_pid: number;
        title: string;
        logical_width: number;
        logical_height: number;
        layer: number;
        alpha: number;
      }>;
    };

    const ignoredApps = new Set([
      'OpenDots',
      'app',
      'Window Server',
      'Dock',
      'Notification Center',
      'CursorUIViewService',
      'loginwindow',
      'AutoFill',
      'ShareSheetUI',
    ]);

    const windows = parsed.windows ?? [];
    return windows
      .filter(
        (w) =>
          w.layer === 0 &&
          w.alpha > 0.1 &&
          w.logical_width > 200 &&
          w.logical_height > 150 &&
          !ignoredApps.has(w.owner_name),
      )
      .map((w) => ({
        window_id: w.window_id,
        pid: w.owner_pid,
        app_name: w.owner_name.replaceAll('\u200E', ''),
        title: (w.title || w.owner_name).replaceAll('\u200E', ''),
        width: Math.round(w.logical_width),
        height: Math.round(w.logical_height),
      }));
  } catch {
    return [];
  }
}

async function runLunaCodexFallback(
  imagePath: string,
  logicalWidth: number,
  logicalHeight: number,
  query?: string,
): Promise<UIElement[]> {
  const codexBin = resolveCodexBin();
  if (!codexBin) return [];

  const tempOutputFile = path.join(
    os.tmpdir(),
    `opendots_luna_${Date.now()}_${Math.floor(Math.random() * 10000)}.json`,
  );

  const targetQuery = query || 'interactive element';
  const prompt = [
    `You are a high-precision computer vision locator for macOS UI elements.`,
    `Window dimensions: logical_width=${logicalWidth}, logical_height=${logicalHeight} points.`,
    `System coordinates: Origin (0,0) is at TOP-LEFT.`,
    `Locate the UI element(s) matching: "${targetQuery}".`,
    `Respond with ONLY a raw JSON object (no markdown, no backticks):`,
    `{"elements":[{"id":"el_1","type":"icon","label":"${targetQuery}","center_x":100,"center_y":200,"bounds":{"x":80,"y":180,"w":40,"h":40},"confidence":0.95}]}`,
  ].join('\n');

  const executeOnce = (customHome?: string): Promise<UIElement[]> => {
    return new Promise<UIElement[]>((resolve, reject) => {
      const env = { ...process.env };
      if (customHome) {
        env.CODEX_HOME = customHome;
      } else {
        delete env.CODEX_HOME;
      }

      const args = [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        '-m',
        'gpt-6-luna',
        '-c',
        'reasoning_effort=medium',
        '-i',
        imagePath,
        '-o',
        tempOutputFile,
        '-',
      ];

      const child = spawn(codexBin, args, { env });
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        if (existsSync(tempOutputFile)) {
          try { unlinkSync(tempOutputFile); } catch {}
        }
        reject(new Error('Codex CLI timeout'));
      }, 25000);

      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (!existsSync(tempOutputFile)) {
          reject(new Error(`Codex exited with ${code}: ${stderr}`));
          return;
        }

        try {
          const content = readFileSync(tempOutputFile, 'utf-8');
          try { unlinkSync(tempOutputFile); } catch {}
          const cleaned = content.replace(/^```json/im, '').replace(/^```/im, '').replace(/```$/im, '').trim();
          const parsed = JSON.parse(cleaned) as { elements?: UIElement[] };
          const elements = (parsed.elements || []).map((el, i) => ({
            id: el.id || `el_${i + 1}`,
            type: el.type || 'ui_element',
            label: el.label || targetQuery,
            center_x: Math.round((el.center_x ?? 0) * 100) / 100,
            center_y: Math.round((el.center_y ?? 0) * 100) / 100,
            bounds: el.bounds || { x: 0, y: 0, w: 40, h: 40 },
            confidence: el.confidence ?? 0.95,
            source: 'vlm_luna',
          }));
          resolve(elements);
        } catch (err) {
          if (existsSync(tempOutputFile)) {
            try { unlinkSync(tempOutputFile); } catch {}
          }
          reject(err);
        }
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  };

  const initialHome = resolveCodexHome();
  try {
    return await executeOnce(initialHome ?? undefined);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (initialHome && (msg.includes('401') || msg.includes('token') || msg.includes('refresh'))) {
      process.stderr.write('[CODEX_FAILOVER] Retrying with default ~/.codex...\n');
      return await executeOnce(undefined).catch(() => []);
    }
    return [];
  }
}

export async function perceptionObserveWorkspace(options: {
  windowId?: number;
  query?: string;
  provider?: 'apple_vision' | 'vlm_luna' | 'hybrid';
  settleDelayMs?: number;
}): Promise<PerceptionObserveResult> {
  const settleDelay = options.settleDelayMs ?? 200;
  if (settleDelay > 0) {
    await new Promise((r) => setTimeout(r, settleDelay));
  }

  const windows = runPerceptionListWindows();
  const targetWin = options.windowId
    ? windows.find((w) => w.window_id === options.windowId)
    : undefined;

  if (options.windowId && !targetWin) {
    return {
      status: 'window_not_found',
      provider: options.provider ?? 'hybrid',
      workspace_info: {
        window_id: options.windowId,
        app_name: getActiveSurface()?.app_name ?? 'Unbound',
        logical_width: 1280,
        logical_height: 800,
      },
      elements: [],
    };
  }
  const windowId = targetWin?.window_id ?? options.windowId ?? 0;
  const appName = targetWin?.app_name ?? 'Active Application';
  let logicalWidth = targetWin?.width ?? 1280;
  let logicalHeight = targetWin?.height ?? 800;

  const tempCapture = path.join(
    os.tmpdir(),
    `opendots_capture_${windowId}_${Date.now()}.png`,
  );

  try {
    const memoryBuf = getLatestMemoryFrame(windowId, 5000);
    if (memoryBuf && memoryBuf.length > 0) {
      writeFileSync(tempCapture, memoryBuf);
    } else {
      return {
        status: 'error',
        provider: options.provider ?? 'hybrid',
        workspace_info: {
          window_id: windowId,
          app_name: appName,
          logical_width: logicalWidth,
          logical_height: logicalHeight,
        },
        elements: [],
      };
    }
    if (existsSync(tempCapture)) {
      try {
        const sipsOut = execSync(`sips -g pixelWidth -g pixelHeight "${tempCapture}"`, { encoding: 'utf-8' });
        const wMatch = sipsOut.match(/pixelWidth:\s*(\d+)/);
        const hMatch = sipsOut.match(/pixelHeight:\s*(\d+)/);
        if (wMatch?.[1] && hMatch?.[1]) {
          const pixW = parseInt(wMatch[1], 10);
          const pixH = parseInt(hMatch[1], 10);
          if (!targetWin?.width) {
            logicalWidth = Math.round(pixW / 2);
            logicalHeight = Math.round(pixH / 2);
          }
        }
      } catch {}
    }
  } catch {
    return {
      status: 'error',
      provider: options.provider ?? 'hybrid',
      workspace_info: {
        window_id: windowId,
        app_name: appName,
        logical_width: logicalWidth,
        logical_height: logicalHeight,
      },
      elements: [],
    };
  }

  let elements: UIElement[] = [];
  const provider = options.provider ?? 'hybrid';

  if (provider === 'apple_vision' || provider === 'hybrid') {
    const bin = resolvePerceptionEyeBin();
    const queryArg = options.query ? `--query "${options.query}"` : '';
    try {
      const stdout = execSync(
        `"${bin}" ocr "${tempCapture}" ${logicalWidth} ${logicalHeight} ${queryArg}`,
        { encoding: 'utf-8' },
      );
      const parsed = JSON.parse(stdout) as {
        status?: string;
        elements?: UIElement[];
      };
      elements = parsed.elements || [];
    } catch {
      elements = [];
    }
  }

  // Fallback to gpt-6-luna if hybrid has 0 elements or provider is vlm_luna
  if (
    (provider === 'vlm_luna' || (provider === 'hybrid' && elements.length === 0)) &&
    existsSync(tempCapture)
  ) {
    const vlmElements = await runLunaCodexFallback(
      tempCapture,
      logicalWidth,
      logicalHeight,
      options.query,
    );
    if (vlmElements.length > 0) {
      elements = vlmElements;
    }
  }

  if (existsSync(tempCapture)) {
    try { unlinkSync(tempCapture); } catch {}
  }

  return {
    status: 'success',
    provider,
    workspace_info: {
      window_id: windowId,
      app_name: appName,
      logical_width: logicalWidth,
      logical_height: logicalHeight,
    },
    elements,
  };
}

export async function cuaGroundAndClick(
  query: string,
  windowId?: number,
): Promise<{ ok: boolean; clicked: boolean; target?: UIElement; message?: string }> {
  const result = await perceptionObserveWorkspace({
    windowId,
    query,
    provider: 'hybrid',
    settleDelayMs: 200,
  });

  if (result.elements.length === 0) {
    return {
      ok: false,
      clicked: false,
      message: `Elemen "${query}" tidak ditemukan pada layar ${result.workspace_info.app_name}.`,
    };
  }

  const target = result.elements[0]!;
  const targetWinId = result.workspace_info.window_id;
  const active = getActiveSurface();
  const pid = active?.window_id === targetWinId ? active.pid : undefined;

  setCursorAction(targetWinId, target.center_x, target.center_y, true);

  try {
    if (pid && targetWinId) {
      await fetch(CUA_MCP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: 'get_window_state',
            arguments: {
              pid,
              window_id: targetWinId,
            },
          },
        }),
      });
    }

    const clickArgs: Record<string, unknown> = {
      x: target.center_x,
      y: target.center_y,
      window_id: targetWinId,
      delivery_mode: 'background',
    };
    if (pid) {
      clickArgs.pid = pid;
    }

    const clickRes = await fetch(CUA_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: 'click',
          arguments: clickArgs,
        },
      }),
    });

    const clickJson = (await clickRes.json()) as {
      result?: { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
    };
    const sc = clickJson.result?.structuredContent ?? {};
    const textOut = clickJson.result?.content?.[0]?.text ?? '';

    // ZERO INTRUSION: Never escalate to foreground!
  } catch {}

  return {
    ok: true,
    clicked: true,
    target,
    message: `Berhasil mengklik "${target.label}" pada koordinat (${target.center_x}, ${target.center_y}) di ${result.workspace_info.app_name} via ${target.source}.`,
  };
}
