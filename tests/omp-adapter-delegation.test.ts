// SPDX-License-Identifier: MIT
// Prompt and target-resolution tests for delegate_to_dot.

import { describe, expect, it } from 'vitest';
import {
  buildReActSystemPrompt,
  delegatedTaskNeedsSurface,
  resolveDelegationTarget,
  type OmpRuntimeContext,
} from '../src/server/omp-adapter.js';
import type { Dot } from '../src/shared/types.js';

function makeDot(patch: Partial<Dot> & Pick<Dot, 'id' | 'name'>): Dot {
  return {
    spaceId: 'space-1',
    spaceIds: ['space-1'],
    instructions: 'General desktop work.',
    memoryAllowed: true,
    createdAt: 1,
    ...patch,
  };
}

function makeRuntime(
  patch: Partial<OmpRuntimeContext> = {},
): OmpRuntimeContext {
  return {
    currentDot: makeDot({ id: 'main-dot', name: 'Main Dot' }),
    spaceId: 'space-1',
    threadId: 'thread-1',
    delegationDepth: 0,
    maxDelegationDepth: 1,
    delegationAttempts: 0,
    collaborators: [],
    activeSurface: null,
    progressEvents: [],
    jitEnabled: false,
    jitApprovals: [],
    ...patch,
  };
}

describe('delegate_to_dot prompt guard', () => {
  const worker = makeDot({
    id: 'worker-dot',
    name: 'Coder Dot',
    instructions: 'Write and verify Node.js automation scripts.',
  });

  it('advertises the tool and collaborator list at depth zero', () => {
    const prompt = buildReActSystemPrompt(
      null,
      'Build a small automation.',
      null,
      makeRuntime({ collaborators: [worker] }),
    );

    expect(prompt).toContain('DOT AKTIF: "Main Dot"');
    expect(prompt).toContain('11. "delegate_to_dot"');
    expect(prompt).toContain('worker-dot');
    expect(prompt).toContain('Coder Dot');
  });

  it('removes the tool at the delegation depth limit', () => {
    const prompt = buildReActSystemPrompt(
      null,
      'Build a small automation.',
      null,
      makeRuntime({
        collaborators: [worker],
        delegationDepth: 1,
        maxDelegationDepth: 1,
      }),
    );

    expect(prompt).not.toContain('11. "delegate_to_dot"');
    expect(prompt).toContain('DELEGASI DOT: Dinonaktifkan');
    expect(prompt).toContain('DELEGATED TASK');
  });

  it('only gives delegated workers a desktop surface when the task needs one', () => {
    expect(delegatedTaskNeedsSurface('Balas hanya dengan kata BANANA.')).toBe(
      false,
    );
    expect(
      delegatedTaskNeedsSurface('Buka Spotify lalu klik tombol play.'),
    ).toBe(true);
    expect(
      delegatedTaskNeedsSurface('Ringkas isi jendela Safari yang aktif.'),
    ).toBe(true);
  });

  it('resolves a target by id, name, or the only collaborator', () => {
    const runtime = makeRuntime({ collaborators: [worker] });

    expect(
      resolveDelegationTarget({ dot_id: 'worker-dot' }, runtime).target?.id,
    ).toBe('worker-dot');
    expect(
      resolveDelegationTarget({ name: 'coder dot' }, runtime).target?.id,
    ).toBe('worker-dot');
    expect(resolveDelegationTarget({}, runtime).target?.id).toBe('worker-dot');
  });

  it('advertises JIT only to the top-level Dot when enabled', () => {
    const topLevel = buildReActSystemPrompt(
      null,
      'Transform this JSON.',
      null,
      makeRuntime({ jitEnabled: true }),
    );
    expect(topLevel).toContain('12. "jit_synthesize_and_run"');
    expect(topLevel).toContain('JIT SCRIPT: Anda dapat memakai');

    const delegated = buildReActSystemPrompt(
      null,
      'Transform this JSON.',
      null,
      makeRuntime({
        jitEnabled: true,
        delegationDepth: 1,
        maxDelegationDepth: 1,
      }),
    );
    expect(delegated).not.toContain('12. "jit_synthesize_and_run"');
    expect(delegated).toContain('JIT SCRIPT: Dinonaktifkan untuk sub-agen');

    const disabled = buildReActSystemPrompt(
      null,
      'Transform this JSON.',
      null,
      makeRuntime({ jitEnabled: false }),
    );
    expect(disabled).not.toContain('jit_synthesize_and_run');
  });

  it('rejects unknown or absent targets', () => {
    const runtime = makeRuntime({ collaborators: [worker] });
    expect(
      resolveDelegationTarget({ dot_id: 'missing' }, runtime).error,
    ).toContain('Dot tujuan tidak ditemukan');

    const noCollaborators = makeRuntime();
    expect(resolveDelegationTarget({}, noCollaborators).error).toContain(
      'Tidak ada Dot lain',
    );
  });
});
