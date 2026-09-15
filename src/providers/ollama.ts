import type { ChatMessage, ChatResult, ChatStreamHandlers, Provider } from './types.js';

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

/**
 * Local Ollama provider — POST /api/chat (sync + stream).
 */
export class OllamaProvider implements Provider {
  readonly id = 'ollama';

  constructor(private readonly opts: OllamaOptions) {}

  private baseUrl(): string {
    return this.opts.host.replace(/\/$/, '');
  }

  async chat(messages: ChatMessage[], opts?: { signal?: AbortSignal }): Promise<ChatResult> {
    return this.chatStream(messages, { signal: opts?.signal });
  }

  async chatStream(messages: ChatMessage[], handlers: ChatStreamHandlers = {}): Promise<ChatResult> {
    const url = `${this.baseUrl()}/api/chat`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.opts.model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
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
      const body = await res.text().catch(() => '');
      throw new OllamaError(
        `Ollama /api/chat returned HTTP ${res.status}${body ? `: ${truncate(body, 200)}` : ''}`,
        'http',
      );
    }

    if (!res.body) {
      // Non-streaming fallback parse
      const data = (await res.json()) as { message?: { content?: string }; model?: string };
      const content = data.message?.content ?? '';
      if (content && handlers.onToken) handlers.onToken(content);
      return { content, model: data.model ?? this.opts.model };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = this.opts.model;

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
            message?: { content?: string };
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
        }
      }

      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim()) as {
            message?: { content?: string };
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

    if (!content.trim()) {
      throw new OllamaError(
        `Ollama returned an empty response for model ${this.opts.model}. Is the model pulled?`,
        'http',
      );
    }

    return { content, model };
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
