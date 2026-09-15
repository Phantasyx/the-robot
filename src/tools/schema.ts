import type { ApprovalTier } from '../core/skills.js';
import { BUILTIN_TOOLS, getToolTier, listAvailableTools } from './builtin.js';
import type { ToolCall, ToolContext, ToolDefinition } from './types.js';

/** OpenAI / Ollama-compatible tool definition. */
export interface OllamaToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Raw tool_call shape from Ollama / OpenAI-compatible responses. */
export interface ModelToolCallRaw {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    index?: number;
    arguments?: Record<string, unknown> | string;
  };
  name?: string;
  arguments?: Record<string, unknown> | string;
}

const PARAMS: Record<string, OllamaToolSpec['function']['parameters']> = {
  list_dir: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path relative to the workspace root (default ".")',
      },
    },
  },
  read_file: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace root',
      },
    },
    required: ['path'],
  },
  write_file: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the workspace root',
      },
      content: {
        type: 'string',
        description: 'UTF-8 text to write',
      },
    },
    required: ['path', 'content'],
  },
  run_command: {
    type: 'object',
    properties: {
      argv: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Preferred: argv array, e.g. ["ls","-la"]. No shell — executed via execFile.',
      },
      command: {
        type: 'string',
        description:
          'Fallback simple command string (no shell metacharacters). Prefer argv.',
      },
    },
  },
};

export function toOllamaTools(
  ctx: Pick<ToolContext, 'enableRunCommand'>,
  defs?: ToolDefinition[],
): OllamaToolSpec[] {
  const list = defs ?? listAvailableTools(ctx);
  return list.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: `${t.description} [approval: ${t.tier}]`,
      parameters: PARAMS[t.name] ?? { type: 'object', properties: {} },
    },
  }));
}

export function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { value: trimmed };
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  return { value: raw };
}

/**
 * Parse model tool_calls into runtime ToolCall objects.
 * Accepts Ollama native shape and OpenAI-ish variants.
 */
export function parseModelToolCalls(raw: ModelToolCallRaw[] | undefined | null): ToolCall[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: ToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name =
      item.function?.name?.trim() ||
      (typeof item.name === 'string' ? item.name.trim() : '') ||
      '';
    if (!name) continue;
    const args = normalizeArgs(item.function?.arguments ?? item.arguments);
    const known = BUILTIN_TOOLS.some((t) => t.name === name);
    const tier: ApprovalTier = known ? getToolTier(name) : 'destructive';
    out.push({ name, args, tier });
  }
  return out;
}

/**
 * Some models emit tool JSON in content instead of structured tool_calls.
 * Best-effort extraction — never throws.
 */
export function extractToolCallsFromContent(content: string): ToolCall[] {
  if (!content?.trim()) return [];
  const trimmed = content.trim();

  // ```json ... ``` or bare JSON object/array
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence?.[1] ?? trimmed).trim();

  const tryParse = (text: string): ToolCall[] => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return parseModelToolCalls(parsed as ModelToolCallRaw[]);
      }
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.tool_calls)) {
          return parseModelToolCalls(obj.tool_calls as ModelToolCallRaw[]);
        }
        if (typeof obj.name === 'string') {
          return parseModelToolCalls([
            {
              function: {
                name: obj.name,
                arguments: (obj.arguments ?? obj.parameters ?? {}) as
                  | Record<string, unknown>
                  | string,
              },
            },
          ]);
        }
      }
    } catch {
      /* ignore */
    }
    return [];
  };

  const direct = tryParse(candidate);
  if (direct.length) return direct;

  // Scan for {"name":"...","arguments":{...}} fragments
  const matches = candidate.matchAll(
    /\{\s*"name"\s*:\s*"([a-zA-Z0-9_]+)"\s*,\s*"(?:arguments|parameters)"\s*:\s*(\{[\s\S]*?\})\s*\}/g,
  );
  const found: ModelToolCallRaw[] = [];
  for (const m of matches) {
    try {
      found.push({
        function: { name: m[1], arguments: JSON.parse(m[2]) as Record<string, unknown> },
      });
    } catch {
      /* skip */
    }
  }
  return parseModelToolCalls(found);
}
