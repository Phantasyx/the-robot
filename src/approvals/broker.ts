import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest } from './gate.js';

export interface PendingApproval extends ApprovalRequest {
  id: string;
  createdAt: number;
}

type Resolver = {
  resolve: (decision: ApprovalDecision) => void;
  pending: PendingApproval;
};

/**
 * In-memory approval broker for GUI / SSE sessions.
 * CLI can ignore this and use sync decideApproval.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Resolver>();

  create(req: ApprovalRequest, timeoutMs = 5 * 60_000): { id: string; promise: Promise<ApprovalDecision> } {
    const id = randomUUID();
    const pending: PendingApproval = { ...req, id, createdAt: Date.now() };

    const promise = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          allowed: false,
          reason: `approval timed out for ${req.action}`,
        });
      }, timeoutMs);

      this.pending.set(id, {
        pending,
        resolve: (decision) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(decision);
        },
      });
    });

    return { id, promise };
  }

  resolve(id: string, allowed: boolean, reason?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.resolve({
      allowed,
      reason:
        reason ??
        (allowed ? `approved via GUI (${entry.pending.action})` : `denied via GUI (${entry.pending.action})`),
    });
    return true;
  }

  get(id: string): PendingApproval | undefined {
    return this.pending.get(id)?.pending;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((v) => v.pending);
  }
}

/** Shared broker for the API process. */
export const globalApprovalBroker = new ApprovalBroker();
