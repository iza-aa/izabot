// SPDX-License-Identifier: MIT
// Sandboxed JIT Script Execution & Dynamic Tool Registry Engine for izabot

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export interface DynamicToolMetadata {
  toolId: string;
  name: string;
  description: string;
  scriptPath: string;
  inputSchemaDescription: string;
  allowedEnvKeys: string[];
  createdAt: number;
  lastVerifiedAt: number;
  successCount: number;
}

export interface ScriptExecutionOptions {
  code: string;
  argsJson?: Record<string, unknown>;
  timeoutMs?: number;
  allowedEnvKeys?: string[];
  keepScratchFile?: boolean;
}

export interface ScriptExecutionResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  parsedJson?: unknown;
  scratchFilePath?: string;
  securityViolation?: string;
}

const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB cap to prevent buffer flooding
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Forbidden code patterns to reject destructive scripts pre-execution.
 */
const FORBIDDEN_CODE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(rm\s+-rf|rmSync|rmdirSync|mkfs|dd\s+if=|shutdown|reboot|launchctl|sudo)\b/i,
    reason: 'Destructive system command detected.',
  },
  {
    pattern: /(\.ssh|\.aws|\.gnupg|\.izanotchy|\/System\/|\/etc\/passwd|\/Library\/Keychains)/i,
    reason: 'Unauthorized access to credentials or system directory.',
  },
  {
    pattern: /\bchild_process\b.*\b(exec|execSync|spawnSync)\b/s,
    reason: 'Usage of child_process.exec/execSync is disallowed in JIT scripts.',
  },
  {
    pattern: /process\.kill\s*\(/,
    reason: 'Process signaling (process.kill) is disallowed.',
  },
];

export function validateScriptSafety(code: string): { safe: boolean; reason?: string } {
  for (const rule of FORBIDDEN_CODE_PATTERNS) {
    if (rule.pattern.test(code)) {
      return { safe: false, reason: rule.reason };
    }
  }
  return { safe: true };
}

export function redactSecrets(text: string, secretValues: string[]): string {
  let cleaned = text;
  for (const secret of secretValues) {
    if (secret && secret.length >= 6) {
      cleaned = cleaned.replaceAll(secret, '[REDACTED_SECRET]');
    }
  }
  return cleaned;
}

/**
 * Executes an ES Module script (.mjs) in an isolated Node.js subprocess
 * with memory cap, environment variable scrubbing, and execution timeout.
 */
export async function runSandboxedScript(
  options: ScriptExecutionOptions,
): Promise<ScriptExecutionResult> {
  const startTime = Date.now();
  const safety = validateScriptSafety(options.code);
  if (!safety.safe) {
    return {
      ok: false,
      exitCode: -1,
      timedOut: false,
      durationMs: 0,
      stdout: '',
      stderr: `SECURITY_GATE_REJECTED: ${safety.reason}`,
      securityViolation: safety.reason,
    };
  }

  const sandboxDir = path.join(os.tmpdir(), 'izabot-jit-sandbox');
  if (!existsSync(sandboxDir)) {
    mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
  }

  const runId = randomUUID();
  const scriptFile = path.join(sandboxDir, `jit_${runId}.mjs`);
  writeFileSync(scriptFile, options.code, { encoding: 'utf-8', mode: 0o600 });

  const safeEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    TZ: process.env.TZ || 'Asia/Jakarta',
    TMPDIR: sandboxDir,
    HOME: sandboxDir,
  };

  const secretValuesToRedact: string[] = [];
  for (const key of options.allowedEnvKeys ?? []) {
    const val = process.env[key];
    if (val) {
      safeEnv[key] = val;
      secretValuesToRedact.push(val);
    }
  }

  const serializedArgs = JSON.stringify(options.argsJson ?? {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ScriptExecutionResult>((resolve) => {
    const nodeArgs = [
      '--max-old-space-size=256',
      '--no-warnings',
      scriptFile,
      serializedArgs,
    ];

    const child = spawn(process.execPath, nodeArgs, {
      cwd: sandboxDir,
      env: safeEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
        stdoutBuf += chunk.toString('utf-8');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBuf.length < MAX_OUTPUT_BYTES) {
        stderrBuf += chunk.toString('utf-8');
      }
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (!options.keepScratchFile && existsSync(scriptFile)) {
        try {
          unlinkSync(scriptFile);
        } catch {}
      }

      const cleanStdout = redactSecrets(stdoutBuf.trim(), secretValuesToRedact);
      const cleanStderr = redactSecrets(stderrBuf.trim(), secretValuesToRedact);

      let parsedJson: unknown;
      let isJsonValid = false;
      if (cleanStdout.length > 0) {
        try {
          const lines = cleanStdout.split('\n');
          const lastJsonLine =
            lines
              .reverse()
              .find((line) => line.trim().startsWith('{') || line.trim().startsWith('[')) ??
            cleanStdout;
          parsedJson = JSON.parse(lastJsonLine);
          isJsonValid = true;
        } catch {
          isJsonValid = false;
        }
      }

      const ok = !timedOut && exitCode === 0 && isJsonValid;
      resolve({
        ok,
        exitCode,
        timedOut,
        durationMs,
        stdout: cleanStdout,
        stderr: timedOut
          ? `${cleanStderr}\n[TIMEOUT]: Execution exceeded ${timeoutMs}ms.`
          : !isJsonValid && exitCode === 0
            ? `${cleanStderr}\n[FORMAT_ERROR]: Script exited with 0 but stdout was not valid JSON.`
            : cleanStderr,
        parsedJson,
        scratchFilePath: options.keepScratchFile ? scriptFile : undefined,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: -1,
        timedOut: false,
        durationMs: Date.now() - startTime,
        stdout: '',
        stderr: err.message,
      });
    });
  });
}

/**
 * Manages the dynamic tools directory.
 */
export function getDynamicToolsDir(): string {
  const dir = path.resolve(process.cwd(), 'data/dynamic-tools');
  const scriptsDir = path.join(dir, 'scripts');
  if (!existsSync(scriptsDir)) {
    mkdirSync(scriptsDir, { recursive: true });
  }
  return dir;
}

export function loadDynamicToolRegistry(): DynamicToolMetadata[] {
  const regPath = path.join(getDynamicToolsDir(), 'registry.json');
  if (!existsSync(regPath)) return [];
  try {
    return JSON.parse(readFileSync(regPath, 'utf-8')) as DynamicToolMetadata[];
  } catch {
    return [];
  }
}

export function promoteScriptToPermanentTool(params: {
  toolId: string;
  name: string;
  description: string;
  code: string;
  inputSchemaDescription: string;
  allowedEnvKeys?: string[];
}): DynamicToolMetadata {
  const baseDir = getDynamicToolsDir();
  const safeId = params.toolId.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const destScriptPath = path.join(baseDir, 'scripts', `${safeId}.mjs`);

  writeFileSync(destScriptPath, params.code, { encoding: 'utf-8', mode: 0o600 });

  const registry = loadDynamicToolRegistry().filter((t) => t.toolId !== safeId);
  const entry: DynamicToolMetadata = {
    toolId: safeId,
    name: params.name,
    description: params.description,
    scriptPath: destScriptPath,
    inputSchemaDescription: params.inputSchemaDescription,
    allowedEnvKeys: params.allowedEnvKeys ?? [],
    createdAt: Date.now(),
    lastVerifiedAt: Date.now(),
    successCount: 1,
  };

  registry.push(entry);
  writeFileSync(
    path.join(baseDir, 'registry.json'),
    JSON.stringify(registry, null, 2),
    'utf-8',
  );
  return entry;
}

export interface JitSynthesisRequest {
  taskGoal: string;
  initialCode: string;
  argsJson?: Record<string, unknown>;
  promoteAsToolId?: string;
  promoteDescription?: string;
  allowedEnvKeys?: string[];
  synthesizeRepairFn: (repairPrompt: string) => Promise<string>;
}

/**
 * Runs a synthesized JIT script with automatic 3x self-healing loop
 * if runtime exceptions, HTTP errors, or JSON parse errors occur.
 */
export async function executeJitWithSelfHealing(
  req: JitSynthesisRequest,
): Promise<{
  finalResult: ScriptExecutionResult;
  attempts: number;
  finalCode: string;
  promotedToolId?: string;
}> {
  const MAX_ATTEMPTS = 3;
  let currentCode = req.initialCode;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const execRes = await runSandboxedScript({
      code: currentCode,
      argsJson: req.argsJson,
      allowedEnvKeys: req.allowedEnvKeys,
      timeoutMs: 15_000,
    });

    if (execRes.securityViolation) {
      return {
        finalResult: execRes,
        attempts: attempt,
        finalCode: currentCode,
      };
    }

    if (execRes.ok) {
      let promotedToolId: string | undefined;
      if (req.promoteAsToolId) {
        const promoted = promoteScriptToPermanentTool({
          toolId: req.promoteAsToolId,
          name: req.promoteAsToolId,
          description: req.promoteDescription ?? req.taskGoal,
          code: currentCode,
          inputSchemaDescription: JSON.stringify(req.argsJson ?? {}),
          allowedEnvKeys: req.allowedEnvKeys,
        });
        promotedToolId = promoted.toolId;
      }

      return {
        finalResult: execRes,
        attempts: attempt,
        finalCode: currentCode,
        promotedToolId,
      };
    }

    if (attempt < MAX_ATTEMPTS) {
      const repairPrompt = [
        `SCRIPT TASK: ${req.taskGoal}`,
        `ATTEMPT ${attempt} FAILED (Exit Code: ${execRes.exitCode}, TimedOut: ${execRes.timedOut}).`,
        ``,
        `CURRENT CODE:`,
        '```javascript',
        currentCode,
        '```',
        ``,
        `STDERR / TRACEBACK:`,
        execRes.stderr || '(empty)',
        ``,
        `STDOUT:`,
        execRes.stdout || '(empty)',
        ``,
        `REPAIR INSTRUCTIONS:`,
        `Fix the root cause of the error above (verify URL endpoint, JSON parsing, or ESM syntax).`,
        `Return ONLY the complete fixed JavaScript (.mjs) code without explanation.`,
      ].join('\n');

      const rawRepaired = await req.synthesizeRepairFn(repairPrompt);
      currentCode = rawRepaired
        .replace(/^```(?:javascript|js|mjs)?/im, '')
        .replace(/```$/im, '')
        .trim();
    } else {
      return {
        finalResult: execRes,
        attempts: attempt,
        finalCode: currentCode,
      };
    }
  }

  throw new Error('Self-healing attempts exceeded.');
}
