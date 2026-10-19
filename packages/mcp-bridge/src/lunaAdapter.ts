import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UIElement } from "./types.js";

interface LunaRawElement {
  id?: string;
  type?: string;
  label?: string;
  target?: string;
  x?: number;
  y?: number;
  center_x?: number;
  center_y?: number;
  bounds?: {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  };
  confidence?: number;
}

interface LunaResponsePayload {
  elements?: LunaRawElement[];
  target?: string;
  x?: number;
  y?: number;
  confidence?: number;
}

interface GPTAccountItem {
  id?: string;
  homeDirectoryPath?: string;
  status?: { type?: string };
}

export function resolveCodexBinaryPath(): string | null {
  if (process.env.CODEX_BIN_PATH && fs.existsSync(process.env.CODEX_BIN_PATH)) {
    return process.env.CODEX_BIN_PATH;
  }

  const homeDir = os.homedir();
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(homeDir, ".local/bin/codex"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveCodexHome(): string | null {
  if (process.env.CODEX_HOME && fs.existsSync(process.env.CODEX_HOME)) {
    return process.env.CODEX_HOME;
  }

  const poolPath = path.join(
    os.homedir(),
    ".izanotchy/credentials/gpt_accounts/pool.json"
  );

  if (fs.existsSync(poolPath)) {
    try {
      const content = fs.readFileSync(poolPath, "utf-8");
      const accounts = JSON.parse(content) as GPTAccountItem[];
      const activeAccount = accounts.find((a) => a.status?.type === "active" && a.homeDirectoryPath);
      if (activeAccount?.homeDirectoryPath && fs.existsSync(activeAccount.homeDirectoryPath)) {
        return activeAccount.homeDirectoryPath;
      }
    } catch {
      // Fallback to standard CODEX_HOME or ~/.codex
    }
  }

  const defaultCodex = path.join(os.homedir(), ".codex");
  if (fs.existsSync(defaultCodex)) {
    return defaultCodex;
  }

  return null;
}

function normalizeLunaOutput(
  rawContent: string,
  logicalWidth: number,
  logicalHeight: number,
  defaultQuery?: string
): UIElement[] {
  const cleaned = rawContent
    .replace(/^```json/im, "")
    .replace(/^```/im, "")
    .replace(/```$/im, "")
    .trim();

  let parsed: LunaResponsePayload;
  try {
    parsed = JSON.parse(cleaned) as LunaResponsePayload;
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse Luna VLM JSON output: ${rawContent.slice(0, 200)}`
    );
  }

  // Handle single-target coordinate output
  if (!parsed.elements && typeof parsed.x === "number" && typeof parsed.y === "number") {
    parsed.elements = [
      {
        id: "el_1",
        type: "ui_element",
        label: parsed.target || defaultQuery || "target_element",
        center_x: parsed.x,
        center_y: parsed.y,
        confidence: parsed.confidence ?? 1.0,
      },
    ];
  }

  const rawElements = Array.isArray(parsed.elements) ? parsed.elements : [];
  const elements: UIElement[] = [];

  for (let i = 0; i < rawElements.length; i++) {
    const el = rawElements[i];
    if (!el) continue;

    let cx = el.center_x ?? el.x ?? 0;
    let cy = el.center_y ?? el.y ?? 0;
    let bx = el.bounds?.x ?? (cx > 20 ? cx - 20 : 0);
    let by = el.bounds?.y ?? (cy > 10 ? cy - 10 : 0);
    let bw = el.bounds?.w ?? 40;
    let bh = el.bounds?.h ?? 20;

    // Scale if normalized fraction (0..1)
    if (cx <= 1.0 && cy <= 1.0 && logicalWidth > 1 && logicalHeight > 1) {
      cx = cx * logicalWidth;
      cy = cy * logicalHeight;
      bx = bx * logicalWidth;
      by = by * logicalHeight;
      bw = bw * logicalWidth;
      bh = bh * logicalHeight;
    }

    elements.push({
      id: el.id || `el_${i + 1}`,
      type: el.type || "ui_element",
      label: el.label || el.target || defaultQuery || "element",
      center_x: Math.round(cx * 100) / 100,
      center_y: Math.round(cy * 100) / 100,
      bounds: {
        x: Math.round(bx * 100) / 100,
        y: Math.round(by * 100) / 100,
        w: Math.round(bw * 100) / 100,
        h: Math.round(bh * 100) / 100,
      },
      confidence: Math.round((el.confidence ?? 0.95) * 1000) / 1000,
      source: "vlm_luna",
    });
  }

  return elements;
}

function buildGroundingPrompt(
  logicalWidth: number,
  logicalHeight: number,
  query?: string
): string {
  return [
    `You are a high-precision computer vision locator for macOS UI elements.`,
    `Window dimensions: logical_width=${logicalWidth}, logical_height=${logicalHeight} points.`,
    `System coordinates: Origin (0,0) is at TOP-LEFT.`,
    query
      ? `Locate the UI element(s) matching: "${query}".`
      : `Detect all interactive UI elements (buttons, inputs, icons, tabs).`,
    `Respond with ONLY a raw JSON object (no markdown quotes, no backticks, no explanatory text):`,
    `{"elements":[{"id":"el_1","type":"icon","label":"${query || "example"}","center_x":100,"center_y":200,"bounds":{"x":80,"y":180,"w":40,"h":40},"confidence":0.95}]}`,
  ].join("\n");
}

async function runLunaViaHttp(
  baseUrl: string,
  imagePath: string,
  logicalWidth: number,
  logicalHeight: number,
  query?: string
): Promise<UIElement[]> {
  const apiKey = process.env.LUNA_VLM_API_KEY || "local-key";
  const model = process.env.LUNA_VLM_MODEL || "gpt-6-luna";
  const reasoningEffort = process.env.LUNA_VLM_REASONING_EFFORT || "medium";

  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString("base64");
  const dataUrl = `data:image/png;base64,${base64Image}`;

  const prompt = buildGroundingPrompt(logicalWidth, logicalHeight, query);

  const endpoint = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const requestBody = {
    model,
    reasoning_effort: reasoningEffort,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: dataUrl },
          },
        ],
      },
    ],
    temperature: 0.1,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Luna VLM HTTP API request failed with status ${response.status}: ${errorBody}`
    );
  }

  const jsonResponse = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const rawContent = jsonResponse.choices?.[0]?.message?.content ?? "";
  return normalizeLunaOutput(rawContent, logicalWidth, logicalHeight, query);
}

function executeCodexProcess(
  codexBinPath: string,
  imagePath: string,
  logicalWidth: number,
  logicalHeight: number,
  query: string | undefined,
  codexHome: string | undefined
): Promise<UIElement[]> {
  const model = process.env.LUNA_VLM_MODEL || "gpt-6-luna";
  const reasoningEffort = process.env.LUNA_VLM_REASONING_EFFORT || "medium";
  const prompt = buildGroundingPrompt(logicalWidth, logicalHeight, query);

  const tempOutputDir = os.tmpdir();
  const tempOutputFile = path.join(
    tempOutputDir,
    `codex_luna_${Date.now()}_${Math.floor(Math.random() * 10000)}.json`
  );

  const env = { ...process.env };
  if (codexHome) {
    env.CODEX_HOME = codexHome;
  } else {
    delete env.CODEX_HOME;
  }

  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-m",
    model,
    "-c",
    `reasoning_effort=${reasoningEffort}`,
    "-i",
    imagePath,
    "-o",
    tempOutputFile,
    "-",
  ];

  return new Promise<UIElement[]>((resolve, reject) => {
    const child = spawn(codexBinPath, args, { env });
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (fs.existsSync(tempOutputFile)) {
        try { fs.unlinkSync(tempOutputFile); } catch {}
      }
      reject(new Error("Codex CLI Luna execution timed out after 30 seconds"));
    }, 30000);

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (fs.existsSync(tempOutputFile)) {
        try { fs.unlinkSync(tempOutputFile); } catch {}
      }
      reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (!fs.existsSync(tempOutputFile)) {
        reject(
          new Error(
            `Codex CLI exited with code ${code} and produced no output file. Stderr: ${stderr.slice(0, 300)}`
          )
        );
        return;
      }

      try {
        const fileContent = fs.readFileSync(tempOutputFile, "utf-8");
        try { fs.unlinkSync(tempOutputFile); } catch {}
        const elements = normalizeLunaOutput(fileContent, logicalWidth, logicalHeight, query);
        resolve(elements);
      } catch (parseErr: unknown) {
        if (fs.existsSync(tempOutputFile)) {
          try { fs.unlinkSync(tempOutputFile); } catch {}
        }
        reject(parseErr);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function runLunaViaCodexCli(
  codexBinPath: string,
  imagePath: string,
  logicalWidth: number,
  logicalHeight: number,
  query?: string
): Promise<UIElement[]> {
  const initialCodexHome = resolveCodexHome();

  try {
    return await executeCodexProcess(
      codexBinPath,
      imagePath,
      logicalWidth,
      logicalHeight,
      query,
      initialCodexHome ?? undefined
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isAuthIncident =
      message.includes("401") ||
      message.includes("token") ||
      message.includes("refresh") ||
      message.includes("Unauthorized") ||
      message.includes("unauthorized");

    // Fast-path failover: if custom pool account had an auth issue, retry with standard ~/.codex
    if (initialCodexHome && isAuthIncident) {
      process.stderr.write(
        `[CODEX_FAILOVER] Authentication incident with pool account: ${message}. Retrying with default credentials...\n`
      );
      return await executeCodexProcess(
        codexBinPath,
        imagePath,
        logicalWidth,
        logicalHeight,
        query,
        undefined
      );
    }
    throw err;
  }
}

export async function runLunaVLM(
  imagePath: string,
  logicalWidth: number,
  logicalHeight: number,
  query?: string
): Promise<UIElement[]> {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file does not exist at path: ${imagePath}`);
  }

  // Path 1: HTTP Bridge / OMP Local Proxy
  const baseUrl = process.env.LUNA_VLM_BASE_URL;
  if (baseUrl && baseUrl.trim().length > 0) {
    return runLunaViaHttp(baseUrl.trim(), imagePath, logicalWidth, logicalHeight, query);
  }

  // Path 2: Auto-fallback to local Codex CLI Session Bridge
  const codexBin = resolveCodexBinaryPath();
  if (codexBin) {
    return runLunaViaCodexCli(codexBin, imagePath, logicalWidth, logicalHeight, query);
  }

  throw new Error(
    "Neither LUNA_VLM_BASE_URL nor Codex CLI binary was found. Configure LUNA_VLM_BASE_URL or install Codex CLI to use gpt-6-luna."
  );
}
