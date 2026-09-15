export interface RunStep {
  index: number;
  kind: 'plan' | 'skill' | 'provider' | 'tool' | 'approval';
  message: string;
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
  skillsLoaded: number;
  routinesLoaded: number;
  ollama: { ok: boolean; detail: string };
  pendingApprovals?: number;
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
