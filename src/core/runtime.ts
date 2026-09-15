import { resolveApproval, type ApprovalDecision, type ApprovalRequest } from '../approvals/gate.js';
import { createMcpClient } from '../mcp/client.js';
import { OllamaError, createProvider } from '../providers/ollama.js';
import type { ChatMessage } from '../providers/types.js';
import {
  executeBuiltinTool,
  formatToolCall,
  listAvailableTools,
  planToolsFromPrompt,
  type ToolCall,
} from '../tools/index.js';
import { ensureWorkspace } from '../tools/sandbox.js';
import type { RobotConfig } from './config.js';
import { findRoutine, loadRoutines, type RoutineConfig } from './routines.js';
import { findSkill, loadSkills, type SkillPack } from './skills.js';

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface RunOptions {
  prompt: string;
  dryRun: boolean;
  skillName?: string;
  routineName?: string;
  maxSteps?: number;
  /** Prior conversation turns (excluding the current prompt). */
  history?: HistoryMessage[];
  /** Interactive approval for prompt mode (GUI / SSE). */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Progressive event sink (steps, tokens, approvals). */
  onEvent?: (event: SessionEvent) => void;
  signal?: AbortSignal;
}

export interface ToolStepMeta {
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  ok?: boolean;
  planned?: boolean;
}

export interface RunStep {
  index: number;
  kind: 'plan' | 'skill' | 'provider' | 'tool' | 'tool_result' | 'approval';
  message: string;
  tool?: ToolStepMeta;
}

export interface RunResult {
  steps: RunStep[];
  summary: string;
}

export type SessionEvent =
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
  | { type: 'error'; message: string };

function emit(opts: RunOptions, event: SessionEvent): void {
  opts.onEvent?.(event);
}

function pushStep(
  steps: RunStep[],
  opts: RunOptions,
  kind: RunStep['kind'],
  message: string,
  tool?: ToolStepMeta,
): RunStep {
  const step: RunStep = { index: steps.length + 1, kind, message, ...(tool ? { tool } : {}) };
  steps.push(step);
  emit(opts, { type: 'step', step });
  return step;
}

function normalizeHistory(history: HistoryMessage[] | undefined, max: number): HistoryMessage[] {
  if (!history?.length) return [];
  const cleaned = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .map((m) => ({ role: m.role, content: String(m.content ?? '').trim() }))
    .filter((m) => m.content.length > 0);
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(-max);
}

function historyDigest(history: HistoryMessage[]): string {
  if (!history.length) return 'no prior turns';
  const users = history.filter((m) => m.role === 'user').length;
  const assistants = history.filter((m) => m.role === 'assistant').length;
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const snippet = lastUser ? lastUser.content.slice(0, 60).replace(/\s+/g, ' ') : '';
  return `${history.length} messages (${users} user / ${assistants} assistant)${
    snippet ? `; last user: "${snippet}${lastUser!.content.length > 60 ? '…' : ''}"` : ''
  }`;
}

export async function runSession(config: RobotConfig, opts: RunOptions): Promise<RunResult> {
  const steps: RunStep[] = [];
  const maxSteps = opts.maxSteps ?? config.maxSteps;
  const history = normalizeHistory(opts.history, config.maxHistoryMessages);

  const workspaceRoot = await ensureWorkspace(config.workspaceRoot);
  const toolCtx = {
    workspaceRoot,
    enableRunCommand: config.enableRunCommand,
    signal: opts.signal,
  };

  const skills = await loadSkills(config.skillsDir);
  const routines = await loadRoutines(config.routinesDir);

  let routine: RoutineConfig | undefined;
  if (opts.routineName) {
    routine = findRoutine(routines, opts.routineName);
    if (!routine) {
      throw new Error(`Unknown routine: ${opts.routineName}`);
    }
    pushStep(steps, opts, 'plan', `Loaded routine "${routine.name}" → skill ${routine.skill}`);
  }

  const prompt = opts.prompt || routine?.prompt || '';
  if (!prompt) {
    throw new Error('No prompt provided. Pass a prompt or --routine <name>.');
  }

  const preferred = opts.skillName ?? routine?.skill;
  let skill: SkillPack | undefined;
  if (preferred) {
    skill = findSkill(skills, preferred);
    if (!skill) {
      throw new Error(`Unknown skill: ${preferred}`);
    }
  } else {
    skill = matchSkill(skills, prompt);
  }

  if (skill) {
    pushStep(
      steps,
      opts,
      'skill',
      `Using skill "${skill.meta.name}" (${skill.meta.approval}): ${skill.meta.description}`,
    );
  } else {
    pushStep(steps, opts, 'plan', 'No matching skill; continuing with bare prompt');
  }

  pushStep(steps, opts, 'plan', `Conversation context: ${historyDigest(history)}`);
  pushStep(
    steps,
    opts,
    'plan',
    `Workspace sandbox: ${workspaceRoot}${config.enableRunCommand ? ' (run_command enabled)' : ''}`,
  );

  const provider = createProvider({ host: config.ollamaHost, model: config.model });
  const mcp = createMcpClient();
  await mcp.connect('local-stub');

  const available = listAvailableTools(toolCtx);
  let plannedTools = planToolsFromPrompt(prompt, toolCtx);

  // Write-tier skills still surface an approval gate even when the heuristic
  // planner only inferred read tools (keeps GUI Approve/Deny demos coherent).
  const skillTier = skill?.meta.approval ?? 'read';
  if (
    (skillTier === 'write' || skillTier === 'destructive') &&
    !plannedTools.some((c) => c.tier === 'write' || c.tier === 'destructive')
  ) {
    plannedTools = [
      ...plannedTools,
      {
        name: 'write_file',
        args: {
          path: 'robot-plan.txt',
          content: `# plan from skill ${skill?.meta.name ?? 'session'}\n${prompt.slice(0, 200)}\n`,
        },
        tier: skillTier === 'destructive' ? 'destructive' : 'write',
      },
    ];
  }

  if (opts.dryRun) {
    pushStep(steps, opts, 'plan', `Dry-run plan for: ${prompt}`);
    if (history.length) {
      pushStep(
        steps,
        opts,
        'plan',
        `Would carry ${history.length} prior turn(s) into the provider / planner`,
      );
    }

    pushStep(
      steps,
      opts,
      'tool',
      `Built-in tools: ${available.map((t) => t.name).join(', ') || '(none)'}`,
    );

    if (plannedTools.length === 0) {
      pushStep(steps, opts, 'plan', 'No built-in tool calls inferred from prompt');
    }

    for (const call of plannedTools) {
      if (steps.length >= maxSteps + 6) break;
      const label = formatToolCall(call);
      if (call.tier === 'write' || call.tier === 'destructive') {
        const decision = await gateWithEvents(config, opts, {
          action: call.name,
          tier: call.tier,
          detail: label,
        });
        pushStep(steps, opts, 'approval', decision.reason);
        if (!decision.allowed) {
          pushStep(steps, opts, 'tool', `Skipped (denied): ${label}`, {
            name: call.name,
            args: call.args,
            planned: true,
            ok: false,
          });
          break;
        }
      }
      pushStep(steps, opts, 'tool', `Plan: ${label} [${call.tier}] (not executed in dry-run)`, {
        name: call.name,
        args: call.args,
        planned: true,
      });
    }

    pushStep(steps, opts, 'plan', 'Produce final response and stop');

    await mcp.disconnect();
    const summary = `Dry-run complete (${steps.length} steps, ${plannedTools.length} tool plan(s), history=${history.length}). Provider=${config.provider} model=${config.model}`;
    emit(opts, { type: 'done', summary, steps });
    return { steps, summary };
  }

  // Live path — call Ollama with history, then execute planned tools with approvals
  const system = buildSystemPrompt(skill, workspaceRoot, available.map((t) => t.name));
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history.map((m) => ({
      role: m.role as ChatMessage['role'],
      content: m.content,
    })),
    { role: 'user', content: prompt },
  ];

  let replyContent = '';
  let replyModel = config.model;
  try {
    const chatStream = provider.chatStream?.bind(provider);
    if (chatStream) {
      const result = await chatStream(messages, {
        signal: opts.signal,
        onToken: (text) => {
          replyContent += text;
          emit(opts, { type: 'token', text });
        },
      });
      replyContent = result.content;
      replyModel = result.model;
    } else {
      const result = await provider.chat(messages, { signal: opts.signal });
      replyContent = result.content;
      replyModel = result.model;
      emit(opts, { type: 'token', text: result.content });
    }
  } catch (err) {
    const message =
      err instanceof OllamaError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    pushStep(steps, opts, 'provider', `Provider error: ${message}`);
    await mcp.disconnect();
    throw new Error(message);
  }

  pushStep(steps, opts, 'provider', replyContent);

  // Execute planned built-in tools (heuristic) after the model reply
  const toolResults: string[] = [];
  for (const call of plannedTools) {
    if (steps.length >= maxSteps + 10) break;
    const label = formatToolCall(call);
    pushStep(steps, opts, 'tool', `Call: ${label}`, {
      name: call.name,
      args: call.args,
      planned: false,
    });

    if (call.tier === 'write' || call.tier === 'destructive') {
      const decision = await gateWithEvents(config, opts, {
        action: call.name,
        tier: call.tier,
        detail: label,
      });
      pushStep(steps, opts, 'approval', decision.reason);
      if (!decision.allowed) {
        pushStep(steps, opts, 'tool_result', `Not executed: ${decision.reason}`, {
          name: call.name,
          args: call.args,
          ok: false,
          result: decision.reason,
        });
        continue;
      }
    }

    const result = await executeBuiltinTool(call, toolCtx);
    toolResults.push(result.content);
    pushStep(
      steps,
      opts,
      'tool_result',
      truncate(result.content, 1200),
      {
        name: call.name,
        args: call.args,
        ok: result.ok,
        result: result.content,
      },
    );
  }

  // If tools ran, optionally ask the model to incorporate results (best-effort; skip if aborted)
  if (toolResults.length > 0 && !opts.signal?.aborted) {
    try {
      const followUp = await provider.chat(
        [
          ...messages,
          { role: 'assistant', content: replyContent },
          {
            role: 'user',
            content: `Tool results:\n\n${toolResults.map((t) => truncate(t, 2000)).join('\n\n---\n\n')}\n\nBriefly incorporate these into your answer for the user.`,
          },
        ],
        { signal: opts.signal },
      );
      if (followUp.content.trim()) {
        replyContent = followUp.content;
        emit(opts, { type: 'token', text: `\n\n${followUp.content}` });
        pushStep(steps, opts, 'provider', followUp.content);
      }
    } catch {
      // Tool results already in activity; follow-up is optional
    }
  }

  const mcpTools = await mcp.listTools();
  pushStep(
    steps,
    opts,
    'tool',
    mcpTools.length === 0
      ? 'MCP: stub client (built-in tools used above)'
      : `MCP tools: ${mcpTools.map((t) => t.name).join(', ')}`,
  );

  await mcp.disconnect();
  const summary = `Session complete. model=${replyModel} tools=${plannedTools.length} history=${history.length}`;
  emit(opts, { type: 'done', summary, steps });
  return { steps, summary };
}

async function gateWithEvents(
  config: RobotConfig,
  opts: RunOptions,
  req: ApprovalRequest,
): Promise<ApprovalDecision> {
  if (config.approvalMode === 'prompt' && opts.requestApproval) {
    return opts.requestApproval(req);
  }
  return resolveApproval(config.approvalMode, req, opts.requestApproval);
}

function matchSkill(skills: SkillPack[], prompt: string): SkillPack | undefined {
  const lower = prompt.toLowerCase();
  for (const s of skills) {
    if (s.meta.triggers.some((t) => lower.includes(t.toLowerCase()))) return s;
    if (lower.includes(s.meta.name.toLowerCase())) return s;
  }
  return undefined;
}

function buildSystemPrompt(
  skill: SkillPack | undefined,
  workspaceRoot: string,
  toolNames: string[],
): string {
  const lines = [
    'You are The Robot, a careful local offline agent.',
    `Workspace root (sandboxed tools): ${workspaceRoot}`,
    toolNames.length
      ? `Built-in tools available via the runtime: ${toolNames.join(', ')}.`
      : 'No built-in tools enabled.',
    'Respect prior conversation turns when answering.',
  ];
  if (skill) {
    lines.push(`Follow skill "${skill.meta.name}":\n${skill.body}`);
  }
  return lines.join('\n\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Exported for tests */
export function __testPlanTools(prompt: string, enableRunCommand = false): ToolCall[] {
  return planToolsFromPrompt(prompt, { enableRunCommand });
}
