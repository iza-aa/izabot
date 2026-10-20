import { computerRoutes } from './computer-routes.js';
import { connectionRoutes } from './connection-routes.js';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { Runner } from './runner.js';
import type { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import { workspaceRoutes } from './workspace-routes.js';
import { deleteAppMemory, listAppMemories } from './app-memory.js';
import { setActiveSurface, getActiveSurface, setCursorAction, getCursorAction, bumpFrameVersion } from './active-surface.js';
import { handleOmpChatCompletion, getLatestExecutionLogs, getTakeoverState, setTakeoverState } from './omp-adapter.js';
import {
  getConnectedWindows,
  captureWindowImage,
  cuaClick,
  cuaSendInputToWindow,
  perceptionObserveWorkspace,
  cuaGroundAndClick,
  cuaClickElementOrCoords,
  resolveBcuBaseUrl,
} from './desktop-tools.js';

const interval = z.number().int().min(60).max(31_536_000).nullable();

export interface AppOptions {
  store: Store;
  runner: Runner;
  ownerToken?: string;
  origin?: string | string[];
  platform?: Platform;
}

export function createApp({
  store,
  runner,
  ownerToken,
  origin,
  platform,
}: AppOptions) {
  const app = new Hono();
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 10 * 1024 * 1024,
      onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    }),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const requestUrl = new URL(c.req.url);
    const origins = origin
      ? Array.isArray(origin)
        ? origin
        : [origin]
      : undefined;
    const originHostnames = origins
      ? origins
          .map((o) => {
            try {
              return new URL(o).hostname;
            } catch {
              return '';
            }
          })
          .filter(Boolean)
      : [];
    const allowedHosts = new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      ...originHostnames,
    ]);
    if (!ownerToken && !allowedHosts.has(requestUrl.hostname))
      return c.json({ error: 'Unrecognized host.' }, 403);
    const requestOrigin = c.req.header('origin');
    const allowedOrigins = new Set(origins ?? [new URL(c.req.url).origin]);
    if (requestOrigin && !allowedOrigins.has(requestOrigin))
      return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    if (c.req.header('sec-fetch-site') === 'cross-site')
      return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
    if (ownerToken) {
      const expected = Buffer.from(ownerToken);
      const supplied = Buffer.from(
        c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
      );
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      )
        return c.json(
          { error: 'Enter your owner access token to unlock OpenDots.' },
          401,
        );
    }
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      !c.req.header('content-type')?.includes('application/json')
    )
      return c.json({ error: 'Use application/json.' }, 415);
    await next();
  });

  if (platform) app.route('/api', computerRoutes(platform.computers));
  if (platform)
    app.route(
      '/api',
      connectionRoutes(platform.workspace, platform.connections),
    );
  const voice = platform ? new VoiceService(platform) : undefined;
  if (platform && voice) app.route('/api', workspaceRoutes(platform, voice));

  app.get('/api/state', (c) =>
    c.json({
      settings: store.settings(),
      tasks: store.tasks(),
      memories: store.memories(),
    }),
  );

  const permissionsFilePath = path.resolve(
    process.env.PERMISSIONS_PATH ?? 'data/permissions.json',
  );
  const bcuAppPath =
    process.env.BCU_APP_PATH ??
    '/Users/heizaaa/Desktop/cdev/background-computer-use/dist/BackgroundComputerUse.app';
  const tauriBinaryPath =
    process.env.TAURI_BINARY_PATH ??
    path.resolve(process.cwd(), 'src-tauri/target/debug/app');
  const cuaSpacesdPath =
    process.env.CUA_SPACESD_PATH ??
    '/Users/heizaaa/Desktop/cdev/cua-spaces-lab/libs/cua-spacesd/target/release/cua-spacesd';
  const cuaMcpUrl = process.env.CUA_MCP_URL ?? 'http://127.0.0.1:3211/mcp';
  const perceptionBinPath =
    process.env.PERCEPTION_BIN_PATH ??
    path.resolve(process.cwd(), 'bin/perception-eye');

  function isStoredAccessibilityGranted(): boolean {
    if (existsSync(permissionsFilePath)) {
      try {
        const raw = readFileSync(permissionsFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.accessibility === true) return true;
      } catch {}
    }
    return false;
  }

  function saveStoredAccessibilityGranted(granted: boolean): void {
    try {
      const dataDir = path.dirname(permissionsFilePath);
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      const current = existsSync(permissionsFilePath)
        ? JSON.parse(readFileSync(permissionsFilePath, 'utf-8'))
        : {};
      current.accessibility = granted;
      current.updated_at = Date.now();
      writeFileSync(permissionsFilePath, JSON.stringify(current, null, 2));
    } catch {}
  }

  // System Readiness & Permissions Checklist API
  // System Readiness & Permissions Checklist API
  app.get('/api/system/permissions', async (c) => {
    let hasAccessibility = false;
    let hasScreenRecording = false;
    let cuaDaemonActive = false;

    // Check Background Computer Use first with auto-launch resilience
    let bcuActive = false;
    let bcuUrl = resolveBcuBaseUrl();

    const checkBcu = async (url: string | null): Promise<boolean> => {
      if (!url) return false;
      try {
        const bcuRes = await fetch(`${url}/v1/bootstrap`, { signal: AbortSignal.timeout(1500) });
        if (bcuRes.ok) {
          bcuActive = true;
          const bcuData = (await bcuRes.json()) as {
            permissions?: { accessibility?: { granted?: boolean }; screenRecording?: { granted?: boolean } };
          };
          hasAccessibility = Boolean(bcuData.permissions?.accessibility?.granted);
          hasScreenRecording = Boolean(bcuData.permissions?.screenRecording?.granted);
          return true;
        }
      } catch {}
      return false;
    };

    const firstCheck = await checkBcu(bcuUrl);
    if (!firstCheck) {
      const bcuApp = bcuAppPath;
      if (existsSync(bcuApp)) {
        try {
          execSync(`open -a "${bcuApp}"`);
          await new Promise((r) => setTimeout(r, 800));
          bcuUrl = resolveBcuBaseUrl();
          await checkBcu(bcuUrl);
        } catch {}
      }
    }

    try {
      const res = await fetch(cuaMcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: 'check_permissions', arguments: {} },
        }),
      });
      if (res.ok) {
        cuaDaemonActive = true;
        const json = ((await res.json()) || {}) as {
          result?: { content?: Array<{ text?: string }> };
        };
        const text = json.result?.content?.[0]?.text ?? '';
        if (!bcuActive) {
          hasAccessibility = text.includes('Accessibility: granted');
          hasScreenRecording = text.includes('Screen Recording: granted');
        }
      }
    } catch {
      cuaDaemonActive = false;
    }

    const binaryPath = tauriBinaryPath;
    const hasPerception = existsSync(perceptionBinPath);

    return c.json({
      accessibility: hasAccessibility,
      screen_recording: hasScreenRecording,
      cua_daemon: cuaDaemonActive || bcuActive,
      perception_engine: hasPerception,
      binary_path: binaryPath,
      user_confirmed: hasAccessibility,
    });
  });

  app.post('/api/system/permissions/confirm', (c) => {
    saveStoredAccessibilityGranted(true);
    return c.json({ ok: true, accessibility: true });
  });

  app.post('/api/system/permissions/reset', (c) => {
    saveStoredAccessibilityGranted(false);
    return c.json({ ok: true, accessibility: false });
  });

  app.post('/api/system/open-settings', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as {
      pane?: 'accessibility' | 'screen-recording' | 'reveal-binary';
      target?: 'bcu' | 'cua' | 'app';
    };
    try {
      if (body.pane === 'accessibility') {
        execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
      } else if (body.pane === 'screen-recording') {
        execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"');
      } else if (body.pane === 'reveal-binary') {
        let targetPath = tauriBinaryPath;
        if (body.target === 'bcu') {
          targetPath = bcuAppPath;
        } else if (body.target === 'cua') {
          targetPath = cuaSpacesdPath;
        }
        if (existsSync(targetPath)) {
          execSync(`open -R "${targetPath}"`);
          execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
        }
      }
      return c.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  app.post('/v1/chat/completions', (c) =>
    handleOmpChatCompletion(c, platform),
  );
  app.post('/api/v1/chat/completions', (c) =>
    handleOmpChatCompletion(c, platform),
  );

  // Connected Apps & Window Canvas API
  app.get('/api/connected-apps/windows', async (c) => {
    const windows = await getConnectedWindows();
    return c.json(windows);
  });

  app.post('/api/connected-apps/active-surface', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as {
      window_id?: number;
      pid?: number;
      app_name?: string;
      title?: string;
      width?: number;
      height?: number;
    };
    if (!body.window_id) {
      return c.json({ error: 'window_id is required' }, 400);
    }
    setActiveSurface({
      window_id: body.window_id,
      pid: body.pid ?? 0,
      app_name: body.app_name ?? 'Active Application',
      title: body.title ?? body.app_name ?? '',
      width: body.width ?? 1280,
      height: body.height ?? 800,
      updated_at: Date.now(),
    });
    return c.json({ ok: true, activeSurface: getActiveSurface() });
  });

  app.get('/api/connected-apps/active-surface', (c) => {
    return c.json(getActiveSurface());
  });
  app.get('/api/connected-apps/cursor', (c) => {
    return c.json(getCursorAction() ?? { x: null, y: null, is_clicking: false });
  });
  app.get('/api/connected-apps/logs', (c) => {
    return c.json(getLatestExecutionLogs());
  });
  app.get('/api/connected-apps/takeover/status', (c) => {
    return c.json(getTakeoverState());
  });
  app.post('/api/connected-apps/takeover/activate', async (c) => {
    const state = getTakeoverState();
    if (state.app_name) {
      try {
        execSync(`osascript -e 'tell application "${state.app_name}" to activate'`);
      } catch {}
    }
    return c.json({ ok: true, activated: true });
  });
  app.post('/api/connected-apps/takeover/resume', async (c) => {
    const state = getTakeoverState();
    setTakeoverState({ active: false });
    try {
      execSync(`osascript -e 'tell application "OpenDots" to activate'`);
    } catch {}
    if (state.window_id) {
      bumpFrameVersion(state.window_id);
    }
    return c.json({ ok: true, resumed: true });
  });
  app.get('/api/connected-apps/capture/:windowId', (c) => {
    const windowId = parseInt(c.req.param('windowId'), 10);
    if (!windowId || isNaN(windowId)) {
      return c.json({ error: 'Invalid window ID' }, 400);
    }
    const imageBuf = captureWindowImage(windowId);
    if (!imageBuf) {
      return c.json({ error: 'Failed to capture window' }, 404);
    }
    return new Response(new Uint8Array(imageBuf), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  });

  app.get('/api/connected-apps/stream/:windowId', (c) => {
    const windowId = parseInt(c.req.param('windowId'), 10);
    if (!windowId || isNaN(windowId)) {
      return c.json({ error: 'Invalid window ID' }, 400);
    }

    c.header('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    c.header('Connection', 'close');
    c.header('Pragma', 'no-cache');

    return stream(c, async (streamWriter) => {
      let active = true;

      streamWriter.onAbort(() => {
        active = false;
      });

      while (active) {
        try {
          const imageBuf = captureWindowImage(windowId);
          if (imageBuf && imageBuf.length > 0) {
            await streamWriter.write(Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${imageBuf.length}\r\n\r\n`));
            await streamWriter.write(imageBuf);
            await streamWriter.write(Buffer.from('\r\n'));
          }
          await new Promise((r) => setTimeout(r, 120));
        } catch {
          active = false;
          break;
        }
      }
    });
  });

  app.post('/api/connected-apps/observe', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as {
      window_id?: number;
      query?: string;
      provider?: 'apple_vision' | 'vlm_luna' | 'hybrid';
      settle_delay_ms?: number;
    };
    const result = await perceptionObserveWorkspace({
      windowId: body.window_id,
      query: body.query,
      provider: body.provider ?? 'hybrid',
      settleDelayMs: body.settle_delay_ms ?? 300,
    });
    return c.json(result);
  });

  app.post('/api/connected-apps/ground-and-click', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as {
      query?: string;
      window_id?: number;
    };
    if (!body.query) {
      return c.json({ error: 'Query is required' }, 400);
    }
    const result = await cuaClickElementOrCoords({
      query: body.query,
      windowId: body.window_id,
    });
    return c.json(result);
  });

  app.post('/api/connected-apps/click', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as {
      x?: number;
      y?: number;
      window_id?: number;
    };
    const x = body.x ?? 100;
    const y = body.y ?? 100;
    const res = await cuaClick(x, y, body.window_id);
    return c.json({ ok: true, result: res });
  });

  app.post('/api/connected-apps/send-input', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) || {}) as {
      window_id?: number;
      pid?: number;
      appName?: string;
      text?: string;
      submit?: boolean;
    };
    if (!body.text?.trim()) {
      return c.json({ error: 'Text cannot be empty' }, 400);
    }
    const report = await cuaSendInputToWindow({
      windowId: body.window_id,
      pid: body.pid,
      appName: body.appName,
      text: body.text.trim(),
      submitWithEnter: body.submit ?? true,
    });
    return c.json({ ok: true, report });
  });

  app.post('/api/tasks', async (c) => {
    const parsed = z
      .object({
        prompt: z.string().trim().min(3).max(4000),
        intervalSeconds: interval.optional(),
        threadId: z.string().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Enter a request between 3 and 4,000 characters; repeat intervals must be at least 60 seconds.',
        },
        400,
      );
    if (platform) {
      if (platform.setup().missing.length)
        return c.json(
          { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
          503,
        );
      if (!parsed.data.threadId)
        return c.json(
          { error: 'Select a conversation for this scheduled task.' },
          400,
        );
      try {
        platform.workspace.requireThread(parsed.data.threadId);
      } catch {
        return c.json(
          { error: 'Conversation is not owned by this workspace.' },
          403,
        );
      }
    }
    const task = store.createTask(
      parsed.data.prompt,
      parsed.data.intervalSeconds,
    );
    if (platform && parsed.data.threadId)
      platform.workspace.bindTask(task.id, parsed.data.threadId);
    return c.json(task, 201);
  });
  app.get('/api/tasks/:id', (c) => {
    const detail = store.detail(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'Task not found.' }, 404);
  });
  app.post('/api/tasks/:id/actions', async (c) => {
    const parsed = z
      .object({ action: z.enum(['run', 'pause', 'cancel']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Unknown task action.' }, 400);
    const task = store.action(c.req.param('id'), parsed.data.action);
    if (parsed.data.action !== 'run') runner.abort(c.req.param('id'));
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.put('/api/tasks/:id/schedule', async (c) => {
    const parsed = z
      .object({ intervalSeconds: interval })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Repeat interval must be 60 seconds to one year, or null.' },
        400,
      );
    const task = store.schedule(c.req.param('id'), parsed.data.intervalSeconds);
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.patch('/api/settings', async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        paused: z.boolean().optional(),
        memoryAllowed: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid settings.' }, 400);
    const previous = store.settings();
    const settings = store.updateSettings(parsed.data);
    if (settings.paused || previous.memoryAllowed !== settings.memoryAllowed)
      runner.abortAll();
    if (settings.paused) voice?.abortAll();
    else void voice?.resumePending();
    return c.json(settings);
  });
  app.post('/api/memories', async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    return c.json(store.saveMemory(parsed.data.text), 201);
  });
  app.put('/api/memories/:id', async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    if (!store.memories().some((m) => m.id === c.req.param('id')))
      return c.json({ error: 'Memory not found.' }, 404);
    return c.json(store.saveMemory(parsed.data.text, c.req.param('id')));
  });
  app.delete('/api/memories/:id', (c) =>
    store.deleteMemory(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Memory not found.' }, 404),
  );
  app.get('/api/app-memories', (c) => c.json(listAppMemories()));
  app.delete('/api/app-memories/:key', (c) =>
    deleteAppMemory(c.req.param('key'))
      ? c.json({ ok: true })
      : c.json({ error: 'App memory not found.' }, 404),
  );
  app.notFound((c) => c.json({ error: 'Not found.' }, 404));
  app.onError((error, c) => {
    console.error('API request failed:', error.name);
    return c.json(
      {
        error:
          'The server could not complete this request. Check server logs and database access.',
      },
      500,
    );
  });
  return app;
}
