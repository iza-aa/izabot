import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runListWindows } from "./perceptionRunner.js";
import { WindowItem, WorkspaceInfo } from "./types.js";

const execFileAsync = promisify(execFile);

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pickActiveWindow(
  windows: WindowItem[],
  targetWindowId?: number
): WindowItem | null {
  if (targetWindowId !== undefined) {
    const matched = windows.find((w) => w.window_id === targetWindowId);
    if (matched) return matched;
  }

  // Filter for normal app windows: layer 0, non-dock, visible
  const candidates = windows.filter((w) => {
    if (w.layer !== 0) return false;
    if (w.alpha < 0.1) return false;
    if (w.logical_width <= 100 || w.logical_height <= 100) return false;
    const name = w.owner_name.toLowerCase();
    if (name === "dock" || name === "window server" || name === "notification center") {
      return false;
    }
    return true;
  });

  return candidates[0] ?? windows[0] ?? null;
}

export async function getImageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFileAsync("sips", [
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      imagePath,
    ]);
    const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
    const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
    const width = widthMatch && widthMatch[1] ? parseInt(widthMatch[1], 10) : 0;
    const height = heightMatch && heightMatch[1] ? parseInt(heightMatch[1], 10) : 0;
    return { width, height };
  } catch {
    return { width: 0, height: 0 };
  }
}

export interface CaptureResult {
  imagePath: string;
  workspaceInfo: WorkspaceInfo;
  isTemporaryFile: boolean;
}

export async function captureWorkspace(options: {
  targetWindowId?: number;
  settleDelayMs?: number;
  imagePath?: string;
}): Promise<CaptureResult> {
  const settleDelay = options.settleDelayMs ?? 300;
  if (settleDelay > 0) {
    await sleep(settleDelay);
  }

  const windows = await runListWindows();
  const selectedWindow = pickActiveWindow(windows, options.targetWindowId);

  const windowId = selectedWindow?.window_id ?? 0;
  const activeAppName = selectedWindow?.owner_name || selectedWindow?.title || "Workspace";
  const logicalWidth = selectedWindow?.logical_width && selectedWindow.logical_width > 0
    ? selectedWindow.logical_width
    : 1024;
  const logicalHeight = selectedWindow?.logical_height && selectedWindow.logical_height > 0
    ? selectedWindow.logical_height
    : 768;

  if (options.imagePath) {
    if (!fs.existsSync(options.imagePath)) {
      throw new Error(`Image file does not exist at path: ${options.imagePath}`);
    }
    const dims = await getImageDimensions(options.imagePath);
    const scaleFactor = dims.width > 0 && logicalWidth > 0
      ? Math.round((dims.width / logicalWidth) * 10) / 10
      : 2.0;

    return {
      imagePath: options.imagePath,
      workspaceInfo: {
        active_app_name: activeAppName,
        window_id: windowId,
        logical_width: logicalWidth,
        logical_height: logicalHeight,
        scale_factor: scaleFactor > 0 ? scaleFactor : 2.0,
      },
      isTemporaryFile: false,
    };
  }

  // Generate temporary capture file
  const tempDir = os.tmpdir();
  const tempCapturePath = path.join(
    tempDir,
    `izabot_workspace_${Date.now()}_${Math.floor(Math.random() * 10000)}.png`
  );

  const captureArgs: string[] = ["-o", "-x"];
  if (windowId > 0) {
    captureArgs.push("-l", String(windowId));
  }
  captureArgs.push(tempCapturePath);

  try {
    await execFileAsync("screencapture", captureArgs);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Fallback: full screen capture if window capture failed
    try {
      await execFileAsync("screencapture", ["-x", tempCapturePath]);
    } catch {
      throw new Error(`Screen capture failed on window ${windowId}: ${message}`);
    }
  }

  if (!fs.existsSync(tempCapturePath)) {
    throw new Error(`Screenshot was not created at expected path: ${tempCapturePath}`);
  }

  const dims = await getImageDimensions(tempCapturePath);
  const scaleFactor = dims.width > 0 && logicalWidth > 0
    ? Math.round((dims.width / logicalWidth) * 10) / 10
    : 2.0;

  return {
    imagePath: tempCapturePath,
    workspaceInfo: {
      active_app_name: activeAppName,
      window_id: windowId,
      logical_width: logicalWidth,
      logical_height: logicalHeight,
      scale_factor: scaleFactor > 0 ? scaleFactor : 2.0,
    },
    isTemporaryFile: true,
  };
}
