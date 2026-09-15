export interface ToolStepMeta {
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  ok?: boolean;
  planned?: boolean;
  source?: 'model' | 'heuristic';
}

export interface RunStep {
  index: number;
  kind: 'plan' | 'skill' | 'provider' | 'tool' | 'tool_result' | 'approval';
  message: string;
  tool?: ToolStepMeta;
}

export interface PendingApproval {
  id: string;
  action: string;
  tier: string;
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  summary?: string;
  steps?: RunStep[];
  error?: boolean;
  streaming?: boolean;
  pendingApproval?: PendingApproval;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
  dryRun: boolean;
  skill?: string;
  routine?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  triggers: string[];
  approval: string;
}

export interface RoutineInfo {
  name: string;
  description?: string;
  schedule?: string;
  trigger?: string;
  skill: string;
  prompt: string;
  enabled?: boolean;
}

export interface HealthInfo {
  ok: boolean;
  product: string;
  version: string;
  provider: string;
  model: string;
  ollamaHost: string;
  approvalMode: string;
  workspaceRoot?: string;
  enableRunCommand?: boolean;
  skillsLoaded: number;
  routinesLoaded: number;
  ollama: { ok: boolean; detail: string };
  pendingApprovals?: number;
  dataDir?: string;
  conversationsDir?: string;
}

export type StreamEvent =
  | { type: 'step'; step: RunStep }
  | { type: 'token'; text: string }
  | {
      type: 'approval_required';
      id: string;
      action: string;
      tier: string;
      detail?: string;
    }
  | { type: 'done'; summary: string; steps: RunStep[] }
  | { type: 'error'; message: string }
  | { type: 'close' };
