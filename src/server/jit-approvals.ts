// SPDX-License-Identifier: MIT
// Owner-gated approval store for JIT script execution.

import { createHash, randomUUID } from 'node:crypto';
import {
  runSandboxedScript,
  validateScriptSafety,
  type ScriptExecutionResult,
} from './dynamic-script-runner.js';

export const JIT_APPROVAL_TTL_MS = 60 * 60 * 1000;
export const JIT_MAX_CODE_CHARS = 20_000;
export const JIT_MAX_ARGS_CHARS = 4_000;
export const JIT_MAX_PENDING_PER_THREAD = 3;
export const JIT_EXECUTION_TIMEOUT_MS = 15_000;

export type JitApprovalStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'expired';

export interface JitApprovalContext {
  threadId: string;
  dotId: string;
  spaceId: string;
}

export interface PendingJitApproval {
  id: string;
  threadId: string;
  dotId: string;
  spaceId: string;
  goal: string;
  code: string;
  codeHash: string;
  argsJson: Record<string, unknown>;
  status: JitApprovalStatus;
  createdAt: number;
  expiresAt: number;
  reviewedAt: number | null;
  result?: ScriptExecutionResult;
}

const approvals = new Map<string, PendingJitApproval>();

function cleanup(now = Date.now()) {
  for (const [id, approval] of approvals) {
    if (
      approval.status === 'pending' &&
      approval.expiresAt <= now
    ) {
      approval.status = 'expired';
    }
    if (
      ['completed', 'failed', 'denied', 'expired'].includes(approval.status) &&
      approval.expiresAt + JIT_APPROVAL_TTL_MS <= now
    ) {
      approvals.delete(id);
    }
  }
}

function requireOwned(id: string, context: JitApprovalContext): PendingJitApproval {
  const approval = approvals.get(id);
  if (!approval) throw new Error('JIT approval not found or already expired.');
  if (
    approval.threadId !== context.threadId ||
    approval.dotId !== context.dotId ||
    approval.spaceId !== context.spaceId
  ) {
    throw new Error('JIT approval does not belong to this Dot, Space, or conversation.');
  }
  if (approval.status === 'expired' || approval.expiresAt <= Date.now()) {
    approval.status = 'expired';
    throw new Error('JIT approval has expired. Ask the Dot to prepare a new one.');
  }
  return approval;
}

export function createJitApproval(params: {
  threadId: string;
  dotId: string;
  spaceId: string;
  goal: string;
  code: string;
  argsJson?: Record<string, unknown>;
}): PendingJitApproval {
  cleanup();
  const goal = params.goal.trim();
  if (!goal) throw new Error('JIT goal is required.');
  if (!params.code.trim()) throw new Error('JIT code is required.');
  if (params.code.length > JIT_MAX_CODE_CHARS) {
    throw new Error(`JIT code exceeds ${JIT_MAX_CODE_CHARS} characters.`);
  }

  const safety = validateScriptSafety(params.code);
  if (!safety.safe) {
    throw new Error(`JIT code rejected by the safety gate: ${safety.reason}`);
  }

  const argsJson = params.argsJson ?? {};
  if (JSON.stringify(argsJson).length > JIT_MAX_ARGS_CHARS) {
    throw new Error(`JIT args exceed ${JIT_MAX_ARGS_CHARS} characters.`);
  }

  const pendingCount = [...approvals.values()].filter(
    (approval) =>
      approval.threadId === params.threadId &&
      (approval.status === 'pending' || approval.status === 'running'),
  ).length;
  if (pendingCount >= JIT_MAX_PENDING_PER_THREAD) {
    throw new Error(
      `This conversation already has ${pendingCount} pending JIT approvals. Review or deny one first.`,
    );
  }

  const now = Date.now();
  const approval: PendingJitApproval = {
    id: randomUUID(),
    threadId: params.threadId,
    dotId: params.dotId,
    spaceId: params.spaceId,
    goal,
    code: params.code,
    codeHash: createHash('sha256').update(params.code).digest('hex').slice(0, 16),
    argsJson,
    status: 'pending',
    createdAt: now,
    expiresAt: now + JIT_APPROVAL_TTL_MS,
    reviewedAt: null,
  };
  approvals.set(approval.id, approval);
  return approval;
}

export function reviewJitApproval(
  id: string,
  context: JitApprovalContext,
): PendingJitApproval {
  cleanup();
  const approval = requireOwned(id, context);
  if (approval.status !== 'pending') {
    throw new Error(`JIT approval is ${approval.status}, not pending.`);
  }
  approval.reviewedAt = Date.now();
  return approval;
}

export async function approveJitApproval(
  id: string,
  context: JitApprovalContext,
): Promise<ScriptExecutionResult> {
  cleanup();
  const approval = requireOwned(id, context);
  if (approval.status !== 'pending') {
    throw new Error(`JIT approval is ${approval.status}, not pending.`);
  }
  if (!approval.reviewedAt) {
    throw new Error(
      `Review the script first with /jit-review ${approval.id} before approving.`,
    );
  }

  approval.status = 'running';
  try {
    const result = await runSandboxedScript({
      code: approval.code,
      argsJson: approval.argsJson,
      timeoutMs: JIT_EXECUTION_TIMEOUT_MS,
      allowedEnvKeys: [],
    });
    approval.result = result;
    approval.status = result.ok ? 'completed' : 'failed';
    return result;
  } catch (error) {
    approval.status = 'failed';
    throw error;
  }
}

export function denyJitApproval(
  id: string,
  context: JitApprovalContext,
): PendingJitApproval {
  cleanup();
  const approval = requireOwned(id, context);
  if (approval.status !== 'pending') {
    throw new Error(`JIT approval is ${approval.status}, not pending.`);
  }
  approval.status = 'denied';
  return approval;
}

export function listJitApprovals(
  context: JitApprovalContext,
): PendingJitApproval[] {
  cleanup();
  return [...approvals.values()].filter(
    (approval) =>
      approval.threadId === context.threadId &&
      approval.dotId === context.dotId &&
      approval.spaceId === context.spaceId &&
      (approval.status === 'pending' || approval.status === 'running'),
  );
}

export function getJitApproval(id: string): PendingJitApproval | undefined {
  cleanup();
  return approvals.get(id);
}

export function resetJitApprovalsForTests() {
  approvals.clear();
}
