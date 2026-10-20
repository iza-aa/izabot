// SPDX-License-Identifier: MIT
// Owner approval lifecycle for JIT scripts.

import { afterEach, describe, expect, it } from 'vitest';
import {
  approveJitApproval,
  createJitApproval,
  denyJitApproval,
  JIT_MAX_PENDING_PER_THREAD,
  resetJitApprovalsForTests,
  reviewJitApproval,
} from '../src/server/jit-approvals.js';
import { handleJitChatCommand } from '../src/server/omp-adapter.js';

const context = {
  threadId: 'thread-1',
  dotId: 'dot-1',
  spaceId: 'space-1',
};

const safeCode = `
  const args = JSON.parse(process.argv[2] || "{}");
  console.log(JSON.stringify({ ok: true, value: (args.x || 0) + 1 }));
`;

afterEach(() => {
  resetJitApprovalsForTests();
});

describe('JIT approvals', () => {
  it('requires review before execution and runs only once', async () => {
    const approval = createJitApproval({
      ...context,
      goal: 'Increment x',
      code: safeCode,
      argsJson: { x: 41 },
    });

    await expect(approveJitApproval(approval.id, context)).rejects.toThrow(
      'Review the script first',
    );

    const reviewed = reviewJitApproval(approval.id, context);
    expect(reviewed.reviewedAt).not.toBeNull();

    const result = await approveJitApproval(approval.id, context);
    expect(result.ok).toBe(true);
    expect(result.parsedJson).toEqual({ ok: true, value: 42 });

    await expect(approveJitApproval(approval.id, context)).rejects.toThrow(
      'not pending',
    );
  });

  it('rejects approval from a different Dot, Space, or thread', () => {
    const approval = createJitApproval({
      ...context,
      goal: 'Scope check',
      code: safeCode,
    });

    expect(() =>
      reviewJitApproval(approval.id, { ...context, threadId: 'other' }),
    ).toThrow('does not belong');
    expect(() =>
      reviewJitApproval(approval.id, { ...context, dotId: 'other' }),
    ).toThrow('does not belong');
    expect(() =>
      reviewJitApproval(approval.id, { ...context, spaceId: 'other' }),
    ).toThrow('does not belong');
  });

  it('denies a request without executing it', async () => {
    const approval = createJitApproval({
      ...context,
      goal: 'Deny me',
      code: safeCode,
    });

    reviewJitApproval(approval.id, context);
    const denied = denyJitApproval(approval.id, context);
    expect(denied.status).toBe('denied');

    await expect(approveJitApproval(approval.id, context)).rejects.toThrow(
      'not pending',
    );
  });

  it('rejects unsafe code before creating an approval', () => {
    expect(() =>
      createJitApproval({
        ...context,
        goal: 'Dangerous',
        code: 'import fs from "fs"; fs.rmSync("/Users/foo", { recursive: true });',
      }),
    ).toThrow('safety gate');
  });

  it('exposes review and one-time approval through chat commands', async () => {
    const approval = createJitApproval({
      ...context,
      goal: 'Chat command flow',
      code: safeCode,
      argsJson: { x: 1 },
    });

    const list = await handleJitChatCommand('/jit-list', context);
    expect(list).toContain(approval.id);
    expect(list).toContain('not reviewed');

    const early = await handleJitChatCommand(
      `/jit-approve ${approval.id}`,
      context,
    );
    expect(early).toContain('Review the script first');

    const review = await handleJitChatCommand(
      `/jit-review ${approval.id}`,
      context,
    );
    expect(review).toContain('```javascript');
    expect(review).toContain('not an OS sandbox');
    expect(review).toContain(`/jit-approve ${approval.id}`);

    const approved = await handleJitChatCommand(
      `/jit-approve ${approval.id}`,
      context,
    );
    expect(approved).toContain('executed: success');
    expect(approved).toContain('"value": 2');

    const second = await handleJitChatCommand(
      `/jit-approve ${approval.id}`,
      context,
    );
    expect(second).toContain('not pending');

    const emptyList = await handleJitChatCommand('/jit-list', context);
    expect(emptyList).toContain('No pending JIT approvals');
  });

  it('caps pending approvals per conversation', () => {
    for (let index = 0; index < JIT_MAX_PENDING_PER_THREAD; index++) {
      createJitApproval({
        ...context,
        goal: `Request ${index}`,
        code: safeCode,
      });
    }

    expect(() =>
      createJitApproval({
        ...context,
        goal: 'One too many',
        code: safeCode,
      }),
    ).toThrow('pending JIT approvals');
  });
});
