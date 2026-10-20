// SPDX-License-Identifier: MIT
// Multi-Agent Swarm Orchestrator for izabot

import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import type {
  TicketStatus,
  AgentSpecialization,
  AgentRoleDefinition,
  HandoffResult,
  AgentHandoffEnvelope,
  TaskTicket,
  SwarmProgressEvent,
} from './swarm-types.js';

export type AgentExecutorFn = (
  role: AgentRoleDefinition,
  envelope: AgentHandoffEnvelope,
  signal: AbortSignal,
) => Promise<HandoffResult>;

export type CriticEvaluatorFn = (
  criticRole: AgentRoleDefinition,
  workerResult: HandoffResult,
  envelope: AgentHandoffEnvelope,
  signal: AbortSignal,
) => Promise<{ approved: boolean; feedback?: string }>;

const MAX_SUMMARY_CHARS = 1200; // Cap to prevent context window explosion

type ResearchToCodePipelineParams = {
  spaceId: string;
  threadId: string;
  userGoal: string;
  researcherDotId: string;
  coderDotId: string;
  reviewerDotId?: string;
};

type ParallelFanOutParams = {
  spaceId: string;
  threadId: string;
  subtasks: Array<{ dotId: string; objective: string }>;
};

export class AgentSwarmOrchestrator extends EventEmitter {
  private tickets = new Map<string, TaskTicket>();
  private roles = new Map<string, AgentRoleDefinition>();
  private visitedSignatures = new Map<string, Set<string>>();
  private surfaceLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly executeAgent: AgentExecutorFn,
    private readonly evaluateCritic?: CriticEvaluatorFn,
  ) {
    super();
  }

  registerRole(role: AgentRoleDefinition): void {
    this.roles.set(role.dotId, role);
  }

  getRole(dotId: string): AgentRoleDefinition | undefined {
    return this.roles.get(dotId);
  }

  getTicket(ticketId: string): TaskTicket | undefined {
    return this.tickets.get(ticketId);
  }

  enqueueTicket(ticket: TaskTicket): void {
    this.tickets.set(ticket.ticketId, ticket);
  }
  listTickets(): TaskTicket[] {
    return Array.from(this.tickets.values());
  }

  /**
   * Distills and sanitizes handoff results to keep context windows clean.
   */
  private sanitizeHandoffResult(raw: HandoffResult): HandoffResult {
    return {
      success: raw.success,
      executiveSummary: (raw.executiveSummary || '').slice(0, MAX_SUMMARY_CHARS).trim(),
      structuredPayload: raw.structuredPayload ?? {},
      artifactPaths: (raw.artifactPaths ?? []).slice(0, 10),
      verificationNotes: (raw.verificationNotes ?? []).slice(0, 8),
      confidenceScore: Math.max(0, Math.min(1, raw.confidenceScore ?? 0.85)),
    };
  }

  /**
   * Mutex lock per app so parallel tasks never collide on physical mouse/BCU cursor.
   */
  async withSurfaceLock<T>(appName: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!appName) return fn();
    const prevLock = this.surfaceLocks.get(appName) ?? Promise.resolve();
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.surfaceLocks.set(appName, prevLock.then(() => nextLock));
    await prevLock;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private transitionStatus(
    ticket: TaskTicket,
    nextStatus: TicketStatus,
    handoverMessage: string,
  ): void {
    ticket.status = nextStatus;
    ticket.updatedAt = Date.now();
    const activeDotId =
      nextStatus === 'REVIEW_REQUIRED' && ticket.reviewerDotId
        ? ticket.reviewerDotId
        : ticket.assignedDotId;
    const role = this.roles.get(activeDotId);
    if (role) {
      const evt: SwarmProgressEvent = {
        workflowId: ticket.workflowId,
        ticketId: ticket.ticketId,
        status: nextStatus,
        activeDot: {
          dotId: role.dotId,
          name: role.name,
          avatarBadge: role.avatarBadge,
          role: role.specialization,
        },
        handoverMessage,
        timestamp: ticket.updatedAt,
      };
      this.emit('swarm:progress', evt);
    }
  }

  /**
   * Executes a single ticket through its complete lifecycle:
   * PENDING -> ASSIGNED -> IN_PROGRESS -> (optional REVIEW_REQUIRED) -> COMPLETED | FAILED
   */
  async runTicket(ticketId: string): Promise<HandoffResult> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found.`);

    const role = this.roles.get(ticket.assignedDotId);
    if (!role) throw new Error(`Role for Dot ${ticket.assignedDotId} is not registered.`);

    // 1. Circuit Breaker: Hop limit
    if (ticket.hopCount > ticket.maxHops) {
      ticket.error = `Circuit breaker active: hop count (${ticket.hopCount}) exceeded limit (${ticket.maxHops}).`;
      this.transitionStatus(ticket, 'FAILED', ticket.error);
      throw new Error(ticket.error);
    }

    // 2. Circuit Breaker: Cycle detection
    const wfSet = this.visitedSignatures.get(ticket.workflowId) ?? new Set<string>();
    const edgeSig = createHash('sha256')
      .update(
        `${ticket.inputEnvelope.fromDotId}->${ticket.inputEnvelope.toDotId}:${ticket.inputEnvelope.taskObjective}:${ticket.rejectionCount}`,
      )
      .digest('hex')
      .slice(0, 16);

    if (wfSet.has(edgeSig)) {
      ticket.error = 'Ping-pong cycle detected between collaborating agents.';
      this.transitionStatus(ticket, 'FAILED', ticket.error);
      throw new Error(ticket.error);
    }
    wfSet.add(edgeSig);
    this.visitedSignatures.set(ticket.workflowId, wfSet);

    // 3. Transition to ASSIGNED
    ticket.leaseOwner = role.dotId;
    ticket.leaseUntil = Date.now() + role.timeoutMs;
    this.transitionStatus(
      ticket,
      'ASSIGNED',
      `${role.avatarBadge} ${role.name} accepted task mandate.`,
    );

    // 4. Execution & Adversarial Review loop
    while (ticket.rejectionCount <= ticket.maxRejections) {
      this.transitionStatus(
        ticket,
        'IN_PROGRESS',
        `${role.avatarBadge} ${role.name} processing: "${ticket.inputEnvelope.taskObjective}"`,
      );

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error(`Timeout after ${role.timeoutMs}ms on ${role.name}`));
      }, role.timeoutMs);

      let rawResult: HandoffResult;
      try {
        rawResult = await this.withSurfaceLock(role.boundAppName, () =>
          this.executeAgent(role, ticket.inputEnvelope, controller.signal),
        );
      } catch (err: unknown) {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        ticket.error = msg;
        this.transitionStatus(ticket, 'FAILED', `${role.name} execution failed: ${msg}`);
        throw err;
      } finally {
        clearTimeout(timer);
      }

      const cleanResult = this.sanitizeHandoffResult(rawResult);

      // 5. Critic review if assigned
      if (ticket.reviewerDotId && this.evaluateCritic) {
        const criticRole = this.roles.get(ticket.reviewerDotId);
        if (criticRole) {
          this.transitionStatus(
            ticket,
            'REVIEW_REQUIRED',
            `${criticRole.avatarBadge} ${criticRole.name} reviewing safety & quality of ${role.name}...`,
          );

          const criticCtrl = new AbortController();
          const criticTimer = setTimeout(() => criticCtrl.abort(), criticRole.timeoutMs);
          try {
            const verdict = await this.evaluateCritic(
              criticRole,
              cleanResult,
              ticket.inputEnvelope,
              criticCtrl.signal,
            );
            if (!verdict.approved) {
              ticket.rejectionCount += 1;
              ticket.hopCount += 1;
              ticket.inputEnvelope.criticFeedback =
                verdict.feedback ?? 'Rejected by Critic without specific reason.';

              if (ticket.rejectionCount > ticket.maxRejections) {
                ticket.error = `Rejected by ${criticRole.name} (${ticket.rejectionCount}x): ${ticket.inputEnvelope.criticFeedback}`;
                this.transitionStatus(ticket, 'FAILED', ticket.error);
                throw new Error(ticket.error);
              }

              this.transitionStatus(
                ticket,
                'ASSIGNED',
                `${criticRole.avatarBadge} ${criticRole.name} requested revision #${ticket.rejectionCount}: "${ticket.inputEnvelope.criticFeedback}"`,
              );
              continue; // Re-run IN_PROGRESS with feedback
            }
          } finally {
            clearTimeout(criticTimer);
          }
        }
      }
      ticket.outputResult = cleanResult;
      ticket.leaseOwner = null;
      ticket.leaseUntil = null;
      this.transitionStatus(
        ticket,
        'COMPLETED',
        `${role.avatarBadge} ${role.name} completed: ${cleanResult.executiveSummary}`,
      );
      return cleanResult;
    }

    throw new Error('Maximum critic rejections exceeded.');
  }

  /**
   * SCENARIO 1 & 3: Linear Pipeline Hand-off (Researcher -> Coder -> Critic Review)
   */
  async executeResearchToCodePipeline(
    params: ResearchToCodePipelineParams,
  ): Promise<{ researchResult: HandoffResult; codeResult: HandoffResult }> {
    const workflowId = randomUUID();
    return this.runResearchToCodePipeline(workflowId, params).finally(() => {
      this.visitedSignatures.delete(workflowId);
    });
  }

  private async runResearchToCodePipeline(
    workflowId: string,
    params: ResearchToCodePipelineParams,
  ): Promise<{ researchResult: HandoffResult; codeResult: HandoffResult }> {
    const now = Date.now();

    // Stage 1: Researcher Ticket
    const researchTicketId = randomUUID();
    const researchEnvelope: AgentHandoffEnvelope = {
      envelopeId: randomUUID(),
      workflowId,
      fromDotId: 'user_or_orchestrator',
      fromRole: 'orchestrator',
      toDotId: params.researcherDotId,
      toRole: 'researcher',
      hopCount: 1,
      maxHops: 5,
      taskObjective: `Research API endpoints, data schemas, and key requirements for: ${params.userGoal}`,
      distilledContext: {
        success: true,
        executiveSummary: params.userGoal,
        structuredPayload: { originalPrompt: params.userGoal },
        artifactPaths: [],
        verificationNotes: ['Verify public accessibility and JSON response schema.'],
        confidenceScore: 1.0,
      },
      createdAt: now,
    };

    this.tickets.set(researchTicketId, {
      ticketId: researchTicketId,
      workflowId,
      spaceId: params.spaceId,
      threadId: params.threadId,
      parentTicketId: null,
      assignedDotId: params.researcherDotId,
      reviewerDotId: null,
      status: 'PENDING',
      priority: 'normal',
      hopCount: 1,
      maxHops: 5,
      rejectionCount: 0,
      maxRejections: 2,
      inputEnvelope: researchEnvelope,
      outputResult: null,
      error: null,
      leaseOwner: null,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
    });

    const researchResult = await this.runTicket(researchTicketId);

    // Stage 2: Distilled hand-off from Researcher to Coder (with optional Critic)
    const coderTicketId = randomUUID();
    const coderEnvelope: AgentHandoffEnvelope = {
      envelopeId: randomUUID(),
      workflowId,
      fromDotId: params.researcherDotId,
      fromRole: 'researcher',
      toDotId: params.coderDotId,
      toRole: 'coder',
      hopCount: 2,
      maxHops: 5,
      taskObjective: `Write and verify self-contained Node.js script (.mjs) based on research specifications for: ${params.userGoal}`,
      distilledContext: researchResult,
      createdAt: Date.now(),
    };

    this.tickets.set(coderTicketId, {
      ticketId: coderTicketId,
      workflowId,
      spaceId: params.spaceId,
      threadId: params.threadId,
      parentTicketId: researchTicketId,
      assignedDotId: params.coderDotId,
      reviewerDotId: params.reviewerDotId ?? null,
      status: 'PENDING',
      priority: 'normal',
      hopCount: 2,
      maxHops: 5,
      rejectionCount: 0,
      maxRejections: 2,
      inputEnvelope: coderEnvelope,
      outputResult: null,
      error: null,
      leaseOwner: null,
      leaseUntil: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const codeResult = await this.runTicket(coderTicketId);
    return { researchResult, codeResult };
  }

  /**
   * SCENARIO 2: Supervisor Fan-Out & Fan-In (Parallel multi-agent execution)
   */
  async executeParallelFanOut(
    params: ParallelFanOutParams,
  ): Promise<Record<string, HandoffResult | { error: string }>> {
    const workflowId = randomUUID();
    return this.runParallelFanOut(workflowId, params).finally(() => {
      this.visitedSignatures.delete(workflowId);
    });
  }

  private async runParallelFanOut(
    workflowId: string,
    params: ParallelFanOutParams,
  ): Promise<Record<string, HandoffResult | { error: string }>> {
    const ticketIds: Array<{ dotId: string; ticketId: string }> = [];

    for (const item of params.subtasks) {
      const role = this.roles.get(item.dotId);
      if (!role) continue;
      const ticketId = randomUUID();
      const now = Date.now();
      this.tickets.set(ticketId, {
        ticketId,
        workflowId,
        spaceId: params.spaceId,
        threadId: params.threadId,
        parentTicketId: null,
        assignedDotId: item.dotId,
        reviewerDotId: null,
        status: 'PENDING',
        priority: 'normal',
        hopCount: 1,
        maxHops: 3,
        rejectionCount: 0,
        maxRejections: 1,
        inputEnvelope: {
          envelopeId: randomUUID(),
          workflowId,
          fromDotId: 'orchestrator',
          fromRole: 'orchestrator',
          toDotId: item.dotId,
          toRole: role.specialization,
          hopCount: 1,
          maxHops: 3,
          taskObjective: item.objective,
          distilledContext: {
            success: true,
            executiveSummary: item.objective,
            structuredPayload: {},
            artifactPaths: [],
            verificationNotes: [],
            confidenceScore: 1.0,
          },
          createdAt: now,
        },
        outputResult: null,
        error: null,
        leaseOwner: null,
        leaseUntil: null,
        createdAt: now,
        updatedAt: now,
      });
      ticketIds.push({ dotId: item.dotId, ticketId });
    }

    const settled = await Promise.allSettled(
      ticketIds.map((t) => this.runTicket(t.ticketId)),
    );

    const aggregated: Record<string, HandoffResult | { error: string }> = {};
    settled.forEach((res, idx) => {
      const dotId = ticketIds[idx]!.dotId;
      if (res.status === 'fulfilled') {
        aggregated[dotId] = res.value;
      } else {
        aggregated[dotId] = {
          error: res.reason instanceof Error ? res.reason.message : String(res.reason),
        };
      }
    });

    return aggregated;
  }

  /**
   * SCENARIO 4: Asynchronous Emergency Escalation (CUA Operator -> Troubleshooter Dot)
   */
  async escalateToTroubleshooter(params: {
    parentTicketId: string;
    fromDotId: string;
    troubleshooterDotId: string;
    anomalyDescription: string;
    screenshotPath?: string;
    axTreeSnippet?: string;
  }): Promise<HandoffResult> {
    const parent = this.tickets.get(params.parentTicketId);
    const workflowId = parent?.workflowId ?? randomUUID();
    const ticketId = randomUUID();
    const now = Date.now();

    this.tickets.set(ticketId, {
      ticketId,
      workflowId,
      spaceId: parent?.spaceId ?? 'default',
      threadId: parent?.threadId ?? 'default',
      parentTicketId: params.parentTicketId,
      assignedDotId: params.troubleshooterDotId,
      reviewerDotId: null,
      status: 'PENDING',
      priority: 'emergency_escalation',
      hopCount: (parent?.hopCount ?? 1) + 1,
      maxHops: 5,
      rejectionCount: 0,
      maxRejections: 1,
      inputEnvelope: {
        envelopeId: randomUUID(),
        workflowId,
        fromDotId: params.fromDotId,
        fromRole: 'cua_operator',
        toDotId: params.troubleshooterDotId,
        toRole: 'troubleshooter',
        hopCount: (parent?.hopCount ?? 1) + 1,
        maxHops: 5,
        taskObjective: `Analyze emergency UI anomaly & recommend recovery action: ${params.anomalyDescription}`,
        distilledContext: {
          success: false,
          executiveSummary: params.anomalyDescription,
          structuredPayload: { axTreeSnippet: (params.axTreeSnippet ?? '').slice(0, 800) },
          artifactPaths: params.screenshotPath ? [params.screenshotPath] : [],
          verificationNotes: ['Return actionable recovery action (e.g. press Escape or click close button).'],
          confidenceScore: 0.5,
        },
        createdAt: now,
      },
      outputResult: null,
      error: null,
      leaseOwner: null,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
    });

    return this.runTicket(ticketId);
  }
}
