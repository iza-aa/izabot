// SPDX-License-Identifier: MIT
// Unit tests for izabot Multi-Agent Swarm Orchestrator

import { describe, it, expect, vi } from 'vitest';
import {
  AgentSwarmOrchestrator,
  type AgentExecutorFn,
  type CriticEvaluatorFn,
} from '../src/server/agent-swarm-orchestrator.js';
import type { AgentRoleDefinition, TaskTicket } from '../src/server/swarm-types.js';

describe('AgentSwarmOrchestrator', () => {
  const researcherRole: AgentRoleDefinition = {
    dotId: 'researcher-dot',
    name: 'Researcher Dot',
    avatarBadge: '[Researcher]',
    specialization: 'researcher',
    systemInstructions: 'Find endpoints and schemas.',
    allowedTools: [],
    maxContextTokens: 4000,
    timeoutMs: 5000,
  };

  const coderRole: AgentRoleDefinition = {
    dotId: 'coder-dot',
    name: 'Coder Dot',
    avatarBadge: '[Coder]',
    specialization: 'coder',
    systemInstructions: 'Write runnable scripts.',
    allowedTools: [],
    maxContextTokens: 4000,
    timeoutMs: 5000,
  };

  const criticRole: AgentRoleDefinition = {
    dotId: 'critic-dot',
    name: 'Critic Dot',
    avatarBadge: '[Critic]',
    specialization: 'critic_reviewer',
    systemInstructions: 'Audit code safety and compliance.',
    allowedTools: [],
    maxContextTokens: 4000,
    timeoutMs: 5000,
  };

  it('executes linear pipeline from researcher to coder to critic', async () => {
    const executeAgent: AgentExecutorFn = vi.fn(async (role) => {
      if (role.specialization === 'researcher') {
        return {
          success: true,
          executiveSummary: 'Found Binance ticker endpoint.',
          structuredPayload: { endpoint: 'https://api.binance.com' },
          artifactPaths: [],
          verificationNotes: ['Public endpoint verified.'],
          confidenceScore: 0.95,
        };
      }
      return {
        success: true,
        executiveSummary: 'Script generated and verified.',
        structuredPayload: { script: 'fetch("https://api.binance.com")' },
        artifactPaths: ['/tmp/script.mjs'],
        verificationNotes: ['All tests passed.'],
        confidenceScore: 0.98,
      };
    });

    const evaluateCritic: CriticEvaluatorFn = vi.fn(async () => ({
      approved: true,
    }));

    const orchestrator = new AgentSwarmOrchestrator(executeAgent, evaluateCritic);
    orchestrator.registerRole(researcherRole);
    orchestrator.registerRole(coderRole);
    orchestrator.registerRole(criticRole);

    const progressEvents: string[] = [];
    orchestrator.on('swarm:progress', (e) => {
      progressEvents.push(`${e.status}:${e.activeDot.name}`);
    });

    const result = await orchestrator.executeResearchToCodePipeline({
      spaceId: 'space-1',
      threadId: 'thread-1',
      userGoal: 'Monitor Binance price',
      researcherDotId: researcherRole.dotId,
      coderDotId: coderRole.dotId,
      reviewerDotId: criticRole.dotId,
    });

    expect(result.researchResult.success).toBe(true);
    expect(result.codeResult.success).toBe(true);
    expect(executeAgent).toHaveBeenCalledTimes(2);
    expect(evaluateCritic).toHaveBeenCalledTimes(1);
    expect(progressEvents).toContain('ASSIGNED:Researcher Dot');
    expect(progressEvents).toContain('COMPLETED:Researcher Dot');
    expect(progressEvents).toContain('REVIEW_REQUIRED:Critic Dot');
    expect(progressEvents).toContain('COMPLETED:Coder Dot');
  });

  it('triggers critic revision feedback loop and retries when rejected', async () => {
    let coderAttempts = 0;
    const executeAgent: AgentExecutorFn = vi.fn(async (role) => {
      if (role.specialization === 'coder') {
        coderAttempts += 1;
        return {
          success: true,
          executiveSummary: `Coder version ${coderAttempts}`,
          structuredPayload: { version: coderAttempts },
          artifactPaths: [],
          verificationNotes: [],
          confidenceScore: 0.9,
        };
      }
      return {
        success: true,
        executiveSummary: 'Research ready',
        structuredPayload: {},
        artifactPaths: [],
        verificationNotes: [],
        confidenceScore: 1.0,
      };
    });

    let criticRejections = 0;
    const evaluateCritic: CriticEvaluatorFn = vi.fn(async () => {
      if (criticRejections === 0) {
        criticRejections += 1;
        return { approved: false, feedback: 'Add timeout to fetch request.' };
      }
      return { approved: true };
    });

    const orchestrator = new AgentSwarmOrchestrator(executeAgent, evaluateCritic);
    orchestrator.registerRole(researcherRole);
    orchestrator.registerRole(coderRole);
    orchestrator.registerRole(criticRole);

    const result = await orchestrator.executeResearchToCodePipeline({
      spaceId: 'space-1',
      threadId: 'thread-1',
      userGoal: 'Build script with timeout',
      researcherDotId: researcherRole.dotId,
      coderDotId: coderRole.dotId,
      reviewerDotId: criticRole.dotId,
    });

    expect(result.codeResult.success).toBe(true);
    expect(coderAttempts).toBe(2);
    expect(evaluateCritic).toHaveBeenCalledTimes(2);
  });

  it('circuit breaker trips when max review rejections are exceeded', async () => {
    const executeAgent: AgentExecutorFn = vi.fn(async () => ({
      success: true,
      executiveSummary: 'Unsafe code generated',
      structuredPayload: {},
      artifactPaths: [],
      verificationNotes: [],
      confidenceScore: 0.5,
    }));

    const evaluateCritic: CriticEvaluatorFn = vi.fn(async () => ({
      approved: false,
      feedback: 'Critical safety violation detected.',
    }));

    const orchestrator = new AgentSwarmOrchestrator(executeAgent, evaluateCritic);
    orchestrator.registerRole(coderRole);
    orchestrator.registerRole(criticRole);

    const ticket: TaskTicket = {
      ticketId: 'unsafe-ticket',
      workflowId: 'wf-unsafe',
      spaceId: 'space-1',
      threadId: 'thread-1',
      parentTicketId: null,
      assignedDotId: coderRole.dotId,
      reviewerDotId: criticRole.dotId,
      status: 'PENDING',
      priority: 'normal',
      hopCount: 1,
      maxHops: 5,
      rejectionCount: 0,
      maxRejections: 1,
      inputEnvelope: {
        envelopeId: 'env-1',
        workflowId: 'wf-unsafe',
        fromDotId: 'user',
        fromRole: 'orchestrator',
        toDotId: coderRole.dotId,
        toRole: 'coder',
        hopCount: 1,
        maxHops: 5,
        taskObjective: 'Run unsafe task',
        distilledContext: {
          success: true,
          executiveSummary: 'task',
          structuredPayload: {},
          artifactPaths: [],
          verificationNotes: [],
          confidenceScore: 1.0,
        },
        createdAt: Date.now(),
      },
      outputResult: null,
      error: null,
      leaseOwner: null,
      leaseUntil: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    orchestrator.enqueueTicket(ticket);

    await expect(orchestrator.runTicket(ticket.ticketId)).rejects.toThrow(/Critical safety violation/);
  });

  it('serializes executions with surface mutex lock on the same bound app', async () => {
    const events: string[] = [];
    const orchestrator = new AgentSwarmOrchestrator(vi.fn());

    const p1 = orchestrator.withSurfaceLock('WhatsApp', async () => {
      events.push('p1-start');
      await Promise.resolve();
      events.push('p1-end');
    });

    const p2 = orchestrator.withSurfaceLock('WhatsApp', async () => {
      events.push('p2-start');
      events.push('p2-end');
    });

    await Promise.all([p1, p2]);
    expect(events).toEqual(['p1-start', 'p1-end', 'p2-start', 'p2-end']);
  });

  it('escalates to troubleshooter on unexpected anomaly', async () => {
    const troubleshooterRole: AgentRoleDefinition = {
      dotId: 'troubleshooter-dot',
      name: 'Troubleshooter Dot',
      avatarBadge: '[Troubleshooter]',
      specialization: 'troubleshooter',
      systemInstructions: 'Diagnose anomalies.',
      allowedTools: [],
      maxContextTokens: 4000,
      timeoutMs: 5000,
    };

    const executeAgent: AgentExecutorFn = vi.fn(async (_role, envelope) => {
      expect(envelope.fromRole).toBe('cua_operator');
      expect(envelope.toRole).toBe('troubleshooter');
      return {
        success: true,
        executiveSummary: 'Close dialog via Escape key.',
        structuredPayload: { recoveryAction: 'press_escape' },
        artifactPaths: [],
        verificationNotes: ['Verified modal close.'],
        confidenceScore: 0.9,
      };
    });

    const orchestrator = new AgentSwarmOrchestrator(executeAgent);
    orchestrator.registerRole(troubleshooterRole);

    const recovery = await orchestrator.escalateToTroubleshooter({
      parentTicketId: 'parent-123',
      fromDotId: 'cua-operator-dot',
      troubleshooterDotId: troubleshooterRole.dotId,
      anomalyDescription: 'Unknown blocking system dialog appeared.',
      screenshotPath: '/tmp/anomaly.png',
      axTreeSnippet: 'AXDialog: Update available',
    });

    expect(recovery.success).toBe(true);
    expect(recovery.structuredPayload).toEqual({ recoveryAction: 'press_escape' });
  });
});
