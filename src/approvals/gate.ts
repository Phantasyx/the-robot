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
 * Synchronous approval gate for deny / auto-approve / none.
 * For `prompt` mode without an interactive handler, returns a soft allow
 * (CLI dry-run demos). Prefer requestApproval hooks for GUI.
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

/**
 * Resolve an approval using an optional interactive handler when mode is `prompt`.
 */
export async function resolveApproval(
  mode: ApprovalMode,
  req: ApprovalRequest,
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
): Promise<ApprovalDecision> {
  if (!needsGate(req.tier)) {
    return { allowed: true, reason: `tier ${req.tier} does not require approval` };
  }
  if (mode === 'prompt' && requestApproval) {
    return requestApproval(req);
  }
  return decideApproval(mode, req);
}
