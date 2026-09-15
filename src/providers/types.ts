export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatResult {
  content: string;
  model: string;
  dryRun?: boolean;
}

export interface ChatStreamHandlers {
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  chat(messages: ChatMessage[], opts?: { signal?: AbortSignal }): Promise<ChatResult>;
  /** Stream tokens when the backend supports it; falls back to a single chat() result. */
  chatStream?(messages: ChatMessage[], handlers?: ChatStreamHandlers): Promise<ChatResult>;
  ping(): Promise<{ ok: boolean; detail: string }>;
}
