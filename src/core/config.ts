import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root when running from src/ or dist/. */
export const ROOT = path.resolve(here, '../..');

export type ApprovalMode = 'prompt' | 'auto-approve' | 'deny';

export interface RobotConfig {
  provider: string;
  ollamaHost: string;
  model: string;
  approvalMode: ApprovalMode;
  skillsDir: string;
  routinesDir: string;
  maxSteps: number;
  /** Sandbox root for built-in file tools. */
  workspaceRoot: string;
  /** Allow destructive run_command tool. */
  enableRunCommand: boolean;
  /** Max prior chat turns (user+assistant pairs roughly) sent to the provider. */
  maxHistoryMessages: number;
}

function approvalMode(raw: string | undefined): ApprovalMode {
  if (raw === 'auto-approve' || raw === 'deny' || raw === 'prompt') return raw;
  return 'prompt';
}

function truthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(overrides: Partial<RobotConfig> = {}): RobotConfig {
  return {
    provider: process.env.ROBOT_PROVIDER ?? 'ollama',
    ollamaHost: process.env.ROBOT_OLLAMA_HOST ?? 'http://127.0.0.1:11434',
    model: process.env.ROBOT_MODEL ?? 'llama3.2',
    approvalMode: approvalMode(process.env.ROBOT_APPROVAL_MODE),
    skillsDir: process.env.ROBOT_SKILLS_DIR ?? path.join(ROOT, 'skills'),
    routinesDir: process.env.ROBOT_ROUTINES_DIR ?? path.join(ROOT, 'routines'),
    maxSteps: 8,
    workspaceRoot: process.env.ROBOT_WORKSPACE ?? process.cwd(),
    enableRunCommand: truthy(process.env.ROBOT_ENABLE_RUN_COMMAND),
    maxHistoryMessages: 24,
    ...overrides,
  };
}
