// SPDX-License-Identifier: MIT
// Unit tests for izabot Dynamic Script Runner & JIT Tool Synthesis

import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  validateScriptSafety,
  redactSecrets,
  runSandboxedScript,
  promoteScriptToPermanentTool,
  loadDynamicToolRegistry,
  executeJitWithSelfHealing,
  getDynamicToolsDir,
} from '../src/server/dynamic-script-runner.js';

describe('DynamicScriptRunner', () => {
  afterEach(() => {
    // Cleanup temporary registry created in test
    const testRegistry = path.join(getDynamicToolsDir(), 'registry.json');
    const testScript = path.join(getDynamicToolsDir(), 'scripts', 'test_calc.mjs');
    if (existsSync(testScript)) {
      try {
        rmSync(testScript);
      } catch {}
    }
    if (existsSync(testRegistry)) {
      try {
        rmSync(testRegistry);
      } catch {}
    }
  });

  it('rejects destructive commands and credential paths pre-execution', () => {
    const dangerousCode = 'import fs from "fs"; fs.rmSync("/Users/foo", { recursive: true });';
    const dangerousSsh = 'const key = fs.readFileSync(process.env.HOME + "/.ssh/id_rsa");';
    const dangerousExec = 'import cp from "child_process"; cp.execSync("whoami");';
    const dangerousSpawn = 'import { spawn } from "node:child_process"; spawn("whoami");';

    expect(validateScriptSafety(dangerousCode).safe).toBe(false);
    expect(validateScriptSafety(dangerousSsh).safe).toBe(false);
    expect(validateScriptSafety(dangerousExec).safe).toBe(false);
    expect(validateScriptSafety(dangerousSpawn).safe).toBe(false);

    const safeCode = `
      const args = JSON.parse(process.argv[2] || "{}");
      console.log(JSON.stringify({ ok: true, sum: (args.a || 0) + (args.b || 0) }));
    `;
    expect(validateScriptSafety(safeCode).safe).toBe(true);
  });

  it('redacts sensitive values from stdout/stderr', () => {
    const rawText = 'Error connecting to API with key sk_live_998877665544332211 on endpoint.';
    const secrets = ['sk_live_998877665544332211'];
    const redacted = redactSecrets(rawText, secrets);

    expect(redacted).not.toContain('sk_live_998877665544332211');
    expect(redacted).toContain('[REDACTED_SECRET]');
  });

  it('executes safe JavaScript (.mjs) in isolated subprocess and parses JSON output', async () => {
    const script = `
      const args = JSON.parse(process.argv[2] || "{}");
      const result = { ok: true, computed: (args.x || 10) * 2 };
      console.log(JSON.stringify(result));
    `;

    const res = await runSandboxedScript({
      code: script,
      argsJson: { x: 21 },
      timeoutMs: 8000,
    });

    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.parsedJson).toEqual({ ok: true, computed: 42 });
  });

  it('promotes successful script to permanent registry', () => {
    const tool = promoteScriptToPermanentTool({
      toolId: 'test_calc',
      name: 'Calculator Tool',
      description: 'Calculates basic numbers',
      code: 'console.log(JSON.stringify({ ok: true }));',
      inputSchemaDescription: '{"x": "number"}',
    });

    expect(tool.toolId).toBe('test_calc');
    expect(existsSync(tool.scriptPath)).toBe(true);

    const registry = loadDynamicToolRegistry();
    const found = registry.find((t) => t.toolId === 'test_calc');
    expect(found).toBeDefined();
    expect(found?.name).toBe('Calculator Tool');
  });

  it('performs self-healing repair loop when initial code throws error', async () => {
    const brokenCode = `
      // Syntax error initially
      const data = undefinedVar.value;
      console.log(JSON.stringify({ ok: true, data }));
    `;

    const fixedCode = `
      const data = 100;
      console.log(JSON.stringify({ ok: true, data }));
    `;

    let repairCalls = 0;
    const result = await executeJitWithSelfHealing({
      taskGoal: 'Return data 100',
      initialCode: brokenCode,
      synthesizeRepairFn: async (repairPrompt) => {
        repairCalls += 1;
        expect(repairPrompt).toContain('ATTEMPT 1 FAILED');
        return fixedCode;
      },
    });

    expect(result.finalResult.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(repairCalls).toBe(1);
    expect(result.finalResult.parsedJson).toEqual({ ok: true, data: 100 });
  });
});
