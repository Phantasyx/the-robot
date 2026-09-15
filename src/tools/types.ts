import type { ApprovalTier } from '../core/skills.js';

export interface ToolDefinition {
  name: string;
  description: string;
  tier: ApprovalTier;
  /** When true, tool is only available if ROBOT_ENABLE_RUN_COMMAND (or config) is on. */
  optional?: boolean;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  tier: ApprovalTier;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  /** Absolute path touched, if any (for display). */
  path?: string;
}

export interface ToolContext {
  workspaceRoot: string;
  enableRunCommand: boolean;
  /** Soft cap for read/list payloads. */
  maxReadBytes?: number;
  /** Hard timeout for run_command (ms). Default 15000. */
  commandTimeoutMs?: number;
  signal?: AbortSignal;
}
