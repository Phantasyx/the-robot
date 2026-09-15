import type { ModelToolCallRaw, OllamaToolSpec } from '../tools/schema.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Structured tool calls from / for the model (Ollama native). */
  tool_calls?: ModelToolCallRaw[];
  /** Tool name when role === 'tool' (Ollama). */
  tool_name?: string;
}

export interface ChatResult {
  content: string;
  model: string;
  dryRun?: boolean;
  /** Parsed tool calls when the model requested tools. */
  toolCalls?: ModelToolCallRaw[];
}

export interface ChatStreamHandlers {
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export interface ChatOptions {
  signal?: AbortSignal;
  /** OpenAI / Ollama-compatible tool specs. When set, model may return tool_calls. */
  tools?: OllamaToolSpec[];
  /**
   * Prefer non-streaming request (better for tool-call rounds).
   * Default: true when tools are provided, false otherwise.
   */
  stream?: boolean;
}

export interface Provider {
  readonly id: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /** Stream tokens when the backend supports it; falls back to a single chat() result. */
  chatStream?(messages: ChatMessage[], handlers?: ChatStreamHandlers & ChatOptions): Promise<ChatResult>;
  ping(): Promise<{ ok: boolean; detail: string }>;
}
