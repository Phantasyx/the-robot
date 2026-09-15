import type { ChatMessage, ChatResult, Provider } from './types.js';

export interface OllamaOptions {
  host: string;
  model: string;
}

/**
 * Local Ollama provider. chat() is stubbed for the scaffold;
 * ping() optionally probes the daemon when network is available.
 */
export class OllamaProvider implements Provider {
  readonly id = 'ollama';

  constructor(private readonly opts: OllamaOptions) {}

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const last = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    // Scaffold stub — replace with POST ${host}/api/chat when wiring live calls.
    return {
      content: `[ollama:${this.opts.model} stub] Would respond to: ${truncate(last, 120)}`,
      model: this.opts.model,
      dryRun: true,
    };
  }

  async ping(): Promise<{ ok: boolean; detail: string }> {
    const url = `${this.opts.host.replace(/\/$/, '')}/api/tags`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) {
        return { ok: false, detail: `Ollama at ${this.opts.host} returned HTTP ${res.status}` };
      }
      return { ok: true, detail: `Ollama reachable at ${this.opts.host} (model target: ${this.opts.model})` };
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
