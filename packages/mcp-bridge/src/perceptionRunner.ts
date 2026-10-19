import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WindowItem,
  WindowListResponse,
  OCRCliResponse,
  UIElement,
} from "./types.js";

const execFileAsync = promisify(execFile);

export function resolvePerceptionEyeBin(): string {
  if (process.env.PERCEPTION_EYE_BIN && fs.existsSync(process.env.PERCEPTION_EYE_BIN)) {
    return process.env.PERCEPTION_EYE_BIN;
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const candidatePaths = [
    path.resolve(__dirname, "../../perception-eye/bin/perception-eye"),
    path.resolve(__dirname, "../../../bin/perception-eye"),
    path.resolve(process.cwd(), "bin/perception-eye"),
    path.resolve(process.cwd(), "packages/perception-eye/bin/perception-eye"),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "perception-eye";
}

export async function runListWindows(): Promise<WindowItem[]> {
  const binary = resolvePerceptionEyeBin();
  try {
    const { stdout } = await execFileAsync(binary, ["list-windows"]);
    const parsed = JSON.parse(stdout) as WindowListResponse;
    if (parsed.status === "success" && Array.isArray(parsed.windows)) {
      return parsed.windows;
    }
    return [];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list windows via perception-eye: ${message}`);
  }
}

export async function runAppleVisionOCR(
  imagePath: string,
  logicalWidth: number,
  logicalHeight: number,
  query?: string
): Promise<UIElement[]> {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file does not exist at path: ${imagePath}`);
  }

  const binary = resolvePerceptionEyeBin();
  const args = [
    "ocr",
    imagePath,
    String(logicalWidth),
    String(logicalHeight),
  ];

  if (query && query.trim().length > 0) {
    args.push("--query", query.trim());
  }

  try {
    const { stdout } = await execFileAsync(binary, args);
    const parsed = JSON.parse(stdout) as OCRCliResponse;
    if (parsed.status === "success" && Array.isArray(parsed.elements)) {
      return parsed.elements;
    }
    return [];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Apple Vision OCR execution failed: ${message}`);
  }
}
