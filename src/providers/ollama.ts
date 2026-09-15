import type { ModelToolCallRaw, OllamaToolSpec } from '../tools/schema.js';
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatStreamHandlers,
  Provider,
} from './types.js';

export interface OllamaOptions {
  host: string;
  model: string;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly code: 'unreachable' | 'http' | 'parse' | 'aborted' = 'http',
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

type OllamaWireMessage = {
  role: string;
  content?: string;
  tool_calls?: ModelToolCallRaw[];
  tool_name?: string;
};

function toWireMessages(messages: ChatMessage[]): OllamaWireMessage[] {
  return messages.map((m) => {
    const out: OllamaWireMessage = { role: m.role, content: m.content ?? '' };
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    if (m.tool_name) out.tool_name = m.tool_name;
    return out;
  });
}

function mergeToolCalls(
  existing: ModelToolCallRaw[],
  incoming: ModelToolCallRaw[] | undefined,
): ModelToolCallRaw[] {
  if (!incoming?.length) return existing;
  // Streaming may send partial tool_calls; replace by index when present, else append.
  const next = [...existing];
  for (let i = 0; i < incoming.length; i++) {
    const tc = incoming[i];
    const idx = tc.function?.index ?? i;
    if (typeof idx === 'number' && idx >= 0 && idx < next.length + 5) {
      while (next.length <= idx) next.push({ function: { name: '', arguments: {} } });
      const prev = next[idx];
      const prevArgs = prev?.function?.arguments;
      const newArgs = tc.function?.arguments;
      let mergedArgs: Record<string, unknown> | string | undefined = newArgs;
      if (typeof prevArgs === 'string' && typeof newArgs === 'string') {
        mergedArgs = prevArgs + newArgs;
      } else if (
        prevArgs &&
        typeof prevArgs === 'object' &&
        newArgs &&
        typeof newArgs === 'object'
      ) {
        mergedArgs = { ...prevArgs, ...newArgs };
      } else if (newArgs == null) {
        mergedArgs = prevArgs;
      }
      next[idx] = {
        ...prev,
        ...tc,
        function: {
          ...prev?.function,
          ...tc.function,
          name: tc.function?.name || prev?.function?.name,
          arguments: mergedArgs ?? {},
        },
      };
    } else {
      next.push(tc);
    }
  }
  return next.filter((t) => t.function?.name);
}

/**
 * Local Ollama provider — POST /api/chat (sync + stream) with optional tools.
 */
export class OllamaProvider implements Provider {
  readonly id = 'ollama';

  constructor(private readonly opts: OllamaOptions) {}

  private baseUrl(): string {
    return this.opts.host.replace(/\/$/, '');
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const wantStream = opts.stream ?? !(opts.tools && opts.tools.length > 0);
    if (wantStream) {
      return this.chatStream(messages, { ...opts, signal: opts.signal });
    }
    return this.chatOnce(messages, opts.tools, opts.signal);
  }

  private async chatOnce(
    messages: ChatMessage[],
    tools: OllamaToolSpec[] | undefined,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const url = `${this.baseUrl()}/api/chat`;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toWireMessages(messages),
      stream: false,
    };
    if (tools?.length) body.tools = tools;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(120_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new OllamaError('Ollama request aborted', 'aborted');
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new OllamaError(
        `Ollama not reachable at ${this.opts.host} (${msg}). Start Ollama or use dry-run.`,
        'unreachable',
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OllamaError(
        `Ollama /api/chat returned HTTP ${res.status}${text ? `: ${truncate(text, 200)}` : ''}`,
        'http',
      );
    }

    let data: {
      message?: { content?: string; tool_calls?: ModelToolCallRaw[] };
      model?: string;
      error?: string;
    };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      throw new OllamaError(
        `Failed parsing Ollama response: ${err instanceof Error ? err.message : String(err)}`,
        'parse',
      );
    }
    if (data.error) throw new OllamaError(`Ollama error: ${data.error}`, 'http');

    const content = data.message?.content ?? '';
    const toolCalls = data.message?.tool_calls?.length ? data.message.tool_calls : undefined;

    if (!content.trim() && !toolCalls?.length) {
      throw new OllamaError(
        `Ollama returned an empty response for model ${this.opts.model}. Is the model pulled?`,
        'http',
      );
    }

    return {
      content,
      model: data.model ?? this.opts.model,
      toolCalls,
    };
  }

  async chatStream(
    messages: ChatMessage[],
    handlers: ChatStreamHandlers & ChatOptions = {},
  ): Promise<ChatResult> {
    // Tool rounds: prefer non-stream for reliable tool_calls assembly
    if (handlers.tools?.length && handlers.stream === false) {
      const result = await this.chatOnce(messages, handlers.tools, handlers.signal);
      if (result.content && handlers.onToken) handlers.onToken(result.content);
      return result;
    }

    const url = `${this.baseUrl()}/api/chat`;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toWireMessages(messages),
      stream: true,
    };
    if (handlers.tools?.length) body.tools = handlers.tools;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: handlers.signal ?? AbortSignal.timeout(120_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new OllamaError('Ollama request aborted', 'aborted');
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new OllamaError(
        `Ollama not reachable at ${this.opts.host} (${msg}). Start Ollama or use dry-run.`,
        'unreachable',
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OllamaError(
        `Ollama /api/chat returned HTTP ${res.status}${text ? `: ${truncate(text, 200)}` : ''}`,
        'http',
      );
    }

    if (!res.body) {
      const data = (await res.json()) as {
        message?: { content?: string; tool_calls?: ModelToolCallRaw[] };
        model?: string;
      };
      const content = data.message?.content ?? '';
      if (content && handlers.onToken) handlers.onToken(content);
      return {
        content,
        model: data.model ?? this.opts.model,
        toolCalls: data.message?.tool_calls,
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = this.opts.model;
    let toolCalls: ModelToolCallRaw[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: {
            message?: { content?: string; tool_calls?: ModelToolCallRaw[] };
            model?: string;
            done?: boolean;
            error?: string;
          };
          try {
            parsed = JSON.parse(trimmed) as typeof parsed;
          } catch {
            continue;
          }
          if (parsed.error) {
            throw new OllamaError(`Ollama error: ${parsed.error}`, 'http');
          }
          if (parsed.model) model = parsed.model;
          const token = parsed.message?.content ?? '';
          if (token) {
            content += token;
            handlers.onToken?.(token);
          }
          if (parsed.message?.tool_calls?.length) {
            toolCalls = mergeToolCalls(toolCalls, parsed.message.tool_calls);
          }
        }
      }

      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim()) as {
            message?: { content?: string; tool_calls?: ModelToolCallRaw[] };
            model?: string;
            error?: string;
          };
          if (parsed.error) throw new OllamaError(`Ollama error: ${parsed.error}`, 'http');
          if (parsed.model) model = parsed.model;
          const token = parsed.message?.content ?? '';
          if (token) {
            content += token;
            handlers.onToken?.(token);
          }
          if (parsed.message?.tool_calls?.length) {
            toolCalls = mergeToolCalls(toolCalls, parsed.message.tool_calls);
          }
        } catch (err) {
          if (err instanceof OllamaError) throw err;
        }
      }
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new OllamaError('Ollama stream aborted', 'aborted');
      }
      throw new OllamaError(
        `Failed reading Ollama stream: ${err instanceof Error ? err.message : String(err)}`,
        'parse',
      );
    }

    if (!content.trim() && toolCalls.length === 0) {
      throw new OllamaError(
        `Ollama returned an empty response for model ${this.opts.model}. Is the model pulled?`,
        'http',
      );
    }

    return {
      content,
      model,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  async ping(): Promise<{ ok: boolean; detail: string }> {
    const url = `${this.baseUrl()}/api/tags`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) {
        return { ok: false, detail: `Ollama at ${this.opts.host} returned HTTP ${res.status}` };
      }
      let models: string[] = [];
      try {
        const data = (await res.json()) as { models?: Array<{ name?: string }> };
        models = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
      } catch {
        /* ignore parse */
      }
      const hasTarget = models.some(
        (n) => n === this.opts.model || n.startsWith(`${this.opts.model}:`),
      );
      const modelNote = models.length
        ? hasTarget
          ? `model ${this.opts.model} available`
          : `model ${this.opts.model} not in local tags (${models.slice(0, 5).join(', ') || 'none'}${models.length > 5 ? '…' : ''})`
        : `model target: ${this.opts.model}`;
      return {
        ok: true,
        detail: `Ollama reachable at ${this.opts.host} (${modelNote})`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        detail: `Ollama not reachable at ${this.opts.host} (${msg}). Offline dry-run still works.`,
      };
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function createProvider(opts: OllamaOptions): Provider {
  return new OllamaProvider(opts);
}
