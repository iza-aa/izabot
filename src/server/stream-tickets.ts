// SPDX-License-Identifier: MIT
// One-time WebSocket tickets for the authenticated window stream.

import { randomUUID } from 'node:crypto';

interface StreamTicket {
  windowId: number;
  expiresAt: number;
}

const STREAM_TICKET_TTL_MS = 30_000;
const tickets = new Map<string, StreamTicket>();

function cleanup(): void {
  const now = Date.now();
  for (const [id, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(id);
  }
}

export function issueStreamTicket(windowId: number): string {
  cleanup();
  const ticket = randomUUID();
  tickets.set(ticket, {
    windowId,
    expiresAt: Date.now() + STREAM_TICKET_TTL_MS,
  });
  return ticket;
}

export function consumeStreamTicket(ticket: string, windowId: number): boolean {
  cleanup();
  const entry = tickets.get(ticket);
  if (!entry || entry.windowId !== windowId) return false;
  tickets.delete(ticket);
  return true;
}

export const STREAM_TICKET_TTL = STREAM_TICKET_TTL_MS;

export function resetStreamTicketsForTests(): void {
  tickets.clear();
}
