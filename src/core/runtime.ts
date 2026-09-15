import { resolveApproval, type ApprovalDecision, type ApprovalRequest } from '../approvals/gate.js';
import { createMcpClient } from '../mcp/client.js';
import { OllamaError, createProvider } from '../providers/ollama.js';
import type { RobotConfig } from './config.js';
import { findRoutine, loadRoutines, type RoutineConfig } from './routines.js';
import { findSkill, loadSkills, type SkillPack } from './skills.js';

export interface RunOptions {
  prompt: string;
  dryRun: boolean;
  skillName?: string;
  routineName?: string;
  maxSteps?: number;
  /** Interactive approval for prompt mode (GUI / SSE). */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Progressive event sink (steps, tokens, approvals). */
  onEvent?: (event: SessionEvent) => void;
  signal?: AbortSignal;
}

export interface RunStep {
  index: number;
  kind: 'plan' | 'skill' | 'provider' | 'tool' | 'approval';
  message: string;
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

function pushStep(steps: RunStep[], opts: RunOptions, kind: RunStep['kind'], message: string): RunStep {
  const step: RunStep = { index: steps.length + 1, kind, message };
  steps.push(step);
  emit(opts, { type: 'step', step });
  return step;
}

export async function runSession(config: RobotConfig, opts: RunOptions): Promise<RunResult> {
  const steps: RunStep[] = [];
  const maxSteps = opts.maxSteps ?? config.maxSteps;

  try {
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

    const provider = createProvider({ host: config.ollamaHost, model: config.model });
    const mcp = createMcpClient();
    await mcp.connect('local-stub');

    if (opts.dryRun) {
      pushStep(steps, opts, 'plan', `Dry-run plan for: ${prompt}`);

      const planned = buildDryRunPlan(prompt, skill, maxSteps);
      for (const item of planned) {
        if (steps.length >= maxSteps + 3) break;
        if (item.tier === 'write' || item.tier === 'destructive') {
          const decision = await gateWithEvents(config, opts, {
            action: item.action,
            tier: item.tier,
            detail: item.detail,
          });
          pushStep(steps, opts, 'approval', decision.reason);
          if (!decision.allowed) break;
        }
        pushStep(steps, opts, item.kind, item.message);
      }

      await mcp.disconnect();
      const summary = `Dry-run complete (${steps.length} steps). Provider=${config.provider} model=${config.model}`;
      emit(opts, { type: 'done', summary, steps });
      return { steps, summary };
    }

    // Live path — call Ollama (stream tokens when possible)
    const system = skill
      ? `You are The Robot. Follow skill "${skill.meta.name}":\n${skill.body}`
      : 'You are The Robot, a careful local agent.';

    let replyContent = '';
    let replyModel = config.model;
    try {
      const chatStream = provider.chatStream?.bind(provider);
      if (chatStream) {
        const result = await chatStream(
          [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          {
            signal: opts.signal,
            onToken: (text) => {
              replyContent += text;
              emit(opts, { type: 'token', text });
            },
          },
        );
        replyContent = result.content;
        replyModel = result.model;
      } else {
        const result = await provider.chat(
          [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          { signal: opts.signal },
        );
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

    // Optional gated follow-up when skill requires write/destructive
    const tier = skill?.meta.approval ?? 'read';
    if (tier === 'write' || tier === 'destructive') {
      const decision = await gateWithEvents(config, opts, {
        action: `${skill?.meta.name ?? 'session'}:${tier}`,
        tier,
        detail: 'live session tool proposal',
      });
      pushStep(steps, opts, 'approval', decision.reason);
    }

    const tools = await mcp.listTools();
    pushStep(
      steps,
      opts,
      'tool',
      tools.length === 0
        ? 'MCP: no tools registered (stub client)'
        : `MCP tools: ${tools.map((t) => t.name).join(', ')}`,
    );

    await mcp.disconnect();
    const summary = `Session complete. model=${replyModel}`;
    emit(opts, { type: 'done', summary, steps });
    return { steps, summary };
  } catch (err) {
    throw err;
  }
}

async function gateWithEvents(
  config: RobotConfig,
  opts: RunOptions,
  req: ApprovalRequest,
): Promise<ApprovalDecision> {
  if (config.approvalMode === 'prompt' && opts.requestApproval) {
    // requestApproval is expected to emit approval_required itself (broker id)
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
  return skills[0];
}

interface PlanItem {
  kind: RunStep['kind'];
  message: string;
  action: string;
  tier: 'none' | 'read' | 'write' | 'destructive';
  detail?: string;
}

function buildDryRunPlan(prompt: string, skill: SkillPack | undefined, maxSteps: number): PlanItem[] {
  const items: PlanItem[] = [
    {
      kind: 'plan',
      message: '1. Gather context from workspace / skill instructions',
      action: 'read-context',
      tier: 'read',
    },
    {
      kind: 'plan',
      message: `2. Draft approach for: ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`,
      action: 'draft',
      tier: 'none',
    },
  ];

  const tier = skill?.meta.approval ?? 'read';
  if (tier === 'write' || tier === 'destructive') {
    items.push({
      kind: 'tool',
      message: `3. Propose ${tier} tool call via MCP (not executed in dry-run)`,
      action: `${skill?.meta.name ?? 'session'}:${tier}`,
      tier,
      detail: 'scaffold dry-run',
    });
  } else {
    items.push({
      kind: 'tool',
      message: '3. Optional read-only tool calls via MCP hooks',
      action: 'mcp-read',
      tier: 'read',
    });
  }

  items.push({
    kind: 'plan',
    message: '4. Produce final response and stop',
    action: 'finish',
    tier: 'none',
  });

  return items.slice(0, Math.max(1, maxSteps));
}
