import type { ApprovalMode } from '../core/config.js';
import type { ApprovalTier } from '../core/skills.js';

export interface ApprovalRequest {
  action: string;
  tier: ApprovalTier;
  detail?: string;
}

export interface ApprovalDecision {
  allowed: boolean;
  reason: string;
}

const TIER_RANK: Record<ApprovalTier, number> = {
  none: 0,
  read: 1,
  write: 2,
  destructive: 3,
};

/** Actions at or above `write` are gated. */
export function needsGate(tier: ApprovalTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK.write;
}

/**
 * Approval gate for destructive / write actions.
 * In this scaffold, `prompt` logs intent and allows (no interactive TTY yet).
 */
export function decideApproval(
  mode: ApprovalMode,
  req: ApprovalRequest,
): ApprovalDecision {
  if (!needsGate(req.tier)) {
    return { allowed: true, reason: `tier ${req.tier} does not require approval` };
  }

  switch (mode) {
    case 'deny':
      return {
        allowed: false,
        reason: `denied by ROBOT_APPROVAL_MODE=deny (${req.action})`,
      };
    case 'auto-approve':
      return {
        allowed: true,
        reason: `auto-approved (${req.action})`,
      };
    case 'prompt':
    default:
      return {
        allowed: true,
        reason: `would prompt for approval: ${req.action}${req.detail ? ` — ${req.detail}` : ''}`,
      };
  }
}
