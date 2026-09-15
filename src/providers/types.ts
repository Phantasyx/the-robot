export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatResult {
  content: string;
  model: string;
  dryRun?: boolean;
}

export interface Provider {
  readonly id: string;
  chat(messages: ChatMessage[]): Promise<ChatResult>;
  ping(): Promise<{ ok: boolean; detail: string }>;
}
