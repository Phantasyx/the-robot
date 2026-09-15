import { resolveApproval, type ApprovalDecision, type ApprovalRequest } from '../approvals/gate.js';
import { createMcpClient } from '../mcp/client.js';
import { OllamaError, createProvider } from '../providers/ollama.js';
import type { ChatMessage } from '../providers/types.js';
import {
  executeBuiltinTool,
  extractToolCallsFromContent,
  formatToolCall,
  listAvailableTools,
  parseModelToolCalls,
  planToolsFromPrompt,
  toOllamaTools,
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
  source?: 'model' | 'heuristic';
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

/** Emit final assistant text in small chunks so the GUI can render progressively. */
async function emitProgressiveTokens(opts: RunOptions, text: string): Promise<void> {
  if (!text) return;
  if (!opts.onEvent) {
    emit(opts, { type: 'token', text });
    return;
  }
  const chunkSize = 36;
  for (let i = 0; i < text.length; i += chunkSize) {
    if (opts.signal?.aborted) break;
    emit(opts, { type: 'token', text: text.slice(i, i + chunkSize) });
    // Yield so SSE / UI can flush between chunks
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
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
    commandTimeoutMs: config.runCommandTimeoutMs,
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
  const ollamaTools = toOllamaTools(toolCtx, available);
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
      `Built-in tools (Ollama-compatible specs): ${available.map((t) => t.name).join(', ') || '(none)'}`,
    );
    pushStep(
      steps,
      opts,
      'plan',
      'Live mode exposes these as model tools; dry-run uses prompt heuristics only',
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
            source: 'heuristic',
          });
          break;
        }
      }
      pushStep(steps, opts, 'tool', `Plan: ${label} [${call.tier}] (not executed in dry-run)`, {
        name: call.name,
        args: call.args,
        planned: true,
        source: 'heuristic',
      });
    }

    pushStep(steps, opts, 'plan', 'Produce final response and stop');

    await mcp.disconnect();
    const summary = `Dry-run complete (${steps.length} steps, ${plannedTools.length} tool plan(s), history=${history.length}). Provider=${config.provider} model=${config.model}`;
    emit(opts, { type: 'done', summary, steps });
    return { steps, summary };
  }

  // ── Live agent loop: model tool-calling with heuristic fallback ──────────
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
  let modelToolRounds = 0;
  let executedFromModel = 0;
  let usedHeuristicFallback = false;

  try {
    const maxRounds = config.maxToolRounds ?? 4;
    for (let round = 0; round < maxRounds; round++) {
      if (opts.signal?.aborted) break;
      if (steps.length >= maxSteps + 20) break;

      pushStep(
        steps,
        opts,
        'plan',
        round === 0
          ? `Calling ${config.provider} with ${ollamaTools.length} tool(s) (round 1/${maxRounds})`
          : `Tool follow-up round ${round + 1}/${maxRounds}`,
      );

      const result = await provider.chat(messages, {
        tools: ollamaTools.length ? ollamaTools : undefined,
        stream: false,
        signal: opts.signal,
      });
      replyModel = result.model;

      let calls = parseModelToolCalls(result.toolCalls);
      if (calls.length === 0 && result.content) {
        calls = extractToolCallsFromContent(result.content);
      }

      // Filter to known/enabled tools
      const enabled = new Set(available.map((t) => t.name));
      calls = calls.filter((c) => enabled.has(c.name));

      if (calls.length > 0) {
        modelToolRounds += 1;
        messages.push({
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.toolCalls?.length
            ? result.toolCalls
            : calls.map((c) => ({
                type: 'function',
                function: { name: c.name, arguments: c.args },
              })),
        });

        pushStep(
          steps,
          opts,
          'provider',
          result.content?.trim()
            ? result.content
            : `Model requested ${calls.length} tool call(s)`,
        );

        for (const call of calls) {
          if (steps.length >= maxSteps + 20) break;
          const label = formatToolCall(call);
          pushStep(steps, opts, 'tool', `Call: ${label}`, {
            name: call.name,
            args: call.args,
            planned: false,
            source: 'model',
          });

          if (call.tier === 'write' || call.tier === 'destructive') {
            const decision = await gateWithEvents(config, opts, {
              action: call.name,
              tier: call.tier,
              detail: label,
            });
            pushStep(steps, opts, 'approval', decision.reason);
            if (!decision.allowed) {
              const denied = `Not executed: ${decision.reason}`;
              pushStep(steps, opts, 'tool_result', denied, {
                name: call.name,
                args: call.args,
                ok: false,
                result: denied,
                source: 'model',
              });
              messages.push({
                role: 'tool',
                tool_name: call.name,
                content: denied,
              });
              continue;
            }
          }

          const toolResult = await executeBuiltinTool(call, toolCtx);
          executedFromModel += 1;
          pushStep(steps, opts, 'tool_result', truncate(toolResult.content, 1200), {
            name: call.name,
            args: call.args,
            ok: toolResult.ok,
            result: toolResult.content,
            source: 'model',
          });
          messages.push({
            role: 'tool',
            tool_name: call.name,
            content: truncate(toolResult.content, 8000),
          });
        }
        continue; // next model round with tool results
      }

      // Final natural-language answer (no tool calls this round)
      replyContent = result.content || '';
      if (replyContent) {
        await emitProgressiveTokens(opts, replyContent);
        pushStep(steps, opts, 'provider', replyContent);
      } else {
        pushStep(steps, opts, 'provider', '(empty model content)');
      }
      messages.push({ role: 'assistant', content: replyContent });
      break;
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

  // Heuristic fallback when the model never returned tool_calls
  if (executedFromModel === 0 && plannedTools.length > 0 && !opts.signal?.aborted) {
    usedHeuristicFallback = true;
    pushStep(
      steps,
      opts,
      'plan',
      'No model tool_calls — falling back to prompt-heuristic tool plan',
    );

    const toolResults: string[] = [];
    for (const call of plannedTools) {
      if (steps.length >= maxSteps + 10) break;
      const label = formatToolCall(call);
      pushStep(steps, opts, 'tool', `Call: ${label}`, {
        name: call.name,
        args: call.args,
        planned: false,
        source: 'heuristic',
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
            source: 'heuristic',
          });
          continue;
        }
      }

      const result = await executeBuiltinTool(call, toolCtx);
      toolResults.push(result.content);
      pushStep(steps, opts, 'tool_result', truncate(result.content, 1200), {
        name: call.name,
        args: call.args,
        ok: result.ok,
        result: result.content,
        source: 'heuristic',
      });
    }

    if (toolResults.length > 0 && !opts.signal?.aborted) {
      try {
        const followMessages: ChatMessage[] = [
          ...messages,
          {
            role: 'user',
            content: `Tool results:\n\n${toolResults.map((t) => truncate(t, 2000)).join('\n\n---\n\n')}\n\nBriefly incorporate these into your answer for the user.`,
          },
        ];
        // No tools on follow-up — stream tokens when the provider supports it
        let followContent = '';
        if (provider.chatStream) {
          const streamed = await provider.chatStream(followMessages, {
            signal: opts.signal,
            stream: true,
            onToken: (token) => {
              followContent += token;
              emit(opts, { type: 'token', text: token });
            },
          });
          followContent = streamed.content || followContent;
          replyModel = streamed.model || replyModel;
        } else {
          const followUp = await provider.chat(followMessages, {
            signal: opts.signal,
            stream: false,
          });
          followContent = followUp.content;
          replyModel = followUp.model || replyModel;
          if (followContent.trim()) {
            await emitProgressiveTokens(opts, followContent);
          }
        }
        if (followContent.trim()) {
          replyContent = followContent;
          pushStep(steps, opts, 'provider', followContent);
        }
      } catch {
        // Tool results already in activity; follow-up is optional
      }
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
  const summary = `Session complete. model=${replyModel} tool_rounds=${modelToolRounds} model_tools=${executedFromModel} heuristic=${usedHeuristicFallback ? 'yes' : 'no'} history=${history.length}`;
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
      ? `You have function tools: ${toolNames.join(', ')}. Call them when you need filesystem or command results. Prefer tools over guessing file contents.`
      : 'No built-in tools enabled.',
    'Respect prior conversation turns when answering.',
    'After tool results arrive, give a concise final answer to the user.',
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
