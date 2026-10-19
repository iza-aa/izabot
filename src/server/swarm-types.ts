// SPDX-License-Identifier: MIT
// Multi-Agent Swarm Data Contracts for izabot

export type TicketStatus =
  | 'PENDING'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'REVIEW_REQUIRED'
  | 'COMPLETED'
  | 'FAILED';

export type AgentSpecialization =
  | 'orchestrator'
  | 'researcher'
  | 'coder'
  | 'cua_operator'
  | 'critic_reviewer'
  | 'troubleshooter';

export interface AgentRoleDefinition {
  dotId: string;
  name: string;
  avatarBadge: string;
  specialization: AgentSpecialization;
  boundAppName?: string;
  systemInstructions: string;
  allowedTools: string[];
  maxContextTokens: number;
  timeoutMs: number;
}

/**
 * Distilled output produced by an executing Dot.
 * Explicitly excludes raw ReAct tree traces to prevent Context Pollution.
 */
export interface HandoffResult {
  success: boolean;
  executiveSummary: string; // Max ~1200 characters concise takeaway
  structuredPayload: Record<string, unknown>; // Parsed data (e.g. API endpoints, code, JSON schemas)
  artifactPaths: string[]; // Paths to generated local files (e.g. .mjs script or screenshot)
  verificationNotes: string[]; // Key safety or operational notes for the next agent
  confidenceScore: number; // 0.0 - 1.0
}

/**
 * Official hand-off envelope passed from one Dot to the next.
 */
export interface AgentHandoffEnvelope {
  envelopeId: string;
  workflowId: string;
  fromDotId: string;
  fromRole: AgentSpecialization;
  toDotId: string;
  toRole: AgentSpecialization;
  hopCount: number;
  maxHops: number;
  taskObjective: string;
  distilledContext: HandoffResult;
  criticFeedback?: string; // Populated when returning from REVIEW_REQUIRED
  createdAt: number;
}

/**
 * Full lifecycle ticket representation on the blackboard.
 */
export interface TaskTicket {
  ticketId: string;
  workflowId: string;
  spaceId: string;
  threadId: string;
  parentTicketId: string | null;
  assignedDotId: string;
  reviewerDotId: string | null;
  status: TicketStatus;
  priority: 'normal' | 'high' | 'emergency_escalation';
  hopCount: number;
  maxHops: number;
  rejectionCount: number;
  maxRejections: number;
  inputEnvelope: AgentHandoffEnvelope;
  outputResult: HandoffResult | null;
  error: string | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

export type SwarmProgressEvent = {
  workflowId: string;
  ticketId: string;
  status: TicketStatus;
  activeDot: {
    dotId: string;
    name: string;
    avatarBadge: string;
    role: AgentSpecialization;
  };
  handoverMessage: string;
  timestamp: number;
};
