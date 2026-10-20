import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeStreamTicket,
  issueStreamTicket,
  resetStreamTicketsForTests,
} from '../src/server/stream-tickets.js';

afterEach(() => {
  vi.useRealTimers();
  resetStreamTicketsForTests();
});

describe('window stream tickets', () => {
  it('issues a one-time ticket bound to one window', () => {
    const ticket = issueStreamTicket(42);
    expect(ticket).toHaveLength(36);
    expect(consumeStreamTicket(ticket, 42)).toBe(true);
    expect(consumeStreamTicket(ticket, 42)).toBe(false);
    expect(consumeStreamTicket(ticket, 43)).toBe(false);
  });

  it('rejects a ticket for a different window', () => {
    const ticket = issueStreamTicket(42);
    expect(consumeStreamTicket(ticket, 7)).toBe(false);
    expect(consumeStreamTicket(ticket, 42)).toBe(true);
  });

  it('expires tickets after 30 seconds', () => {
    vi.useFakeTimers();
    const ticket = issueStreamTicket(42);
    vi.advanceTimersByTime(30_001);
    expect(consumeStreamTicket(ticket, 42)).toBe(false);
  });
});
