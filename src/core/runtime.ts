import { decideApproval } from '../approvals/gate.js';
import { createMcpClient } from '../mcp/client.js';
import { createProvider } from '../providers/ollama.js';
import type { RobotConfig } from './config.js';
import { findRoutine, loadRoutines, type RoutineConfig } from './routines.js';
import { findSkill, loadSkills, type SkillPack } from './skills.js';

export interface RunOptions {
  prompt: string;
  dryRun: boolean;
  skillName?: string;
  routineName?: string;
  maxSteps?: number;
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

export async function runSession(config: RobotConfig, opts: RunOptions): Promise<RunResult> {
  const steps: RunStep[] = [];
  const maxSteps = opts.maxSteps ?? config.maxSteps;

  const skills = await loadSkills(config.skillsDir);
  const routines = await loadRoutines(config.routinesDir);

  let routine: RoutineConfig | undefined;
  if (opts.routineName) {
    routine = findRoutine(routines, opts.routineName);
    if (!routine) {
      throw new Error(`Unknown routine: ${opts.routineName}`);
    }
    steps.push({
      index: steps.length + 1,
      kind: 'plan',
      message: `Loaded routine "${routine.name}" → skill ${routine.skill}`,
    });
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
    steps.push({
      index: steps.length + 1,
      kind: 'skill',
      message: `Using skill "${skill.meta.name}" (${skill.meta.approval}): ${skill.meta.description}`,
    });
  } else {
    steps.push({
      index: steps.length + 1,
      kind: 'plan',
      message: 'No matching skill; continuing with bare prompt',
    });
  }

  const provider = createProvider({ host: config.ollamaHost, model: config.model });
  const mcp = createMcpClient();
  await mcp.connect('local-stub');

  if (opts.dryRun) {
    steps.push({
      index: steps.length + 1,
      kind: 'plan',
      message: `Dry-run plan for: ${prompt}`,
    });

    const planned = buildDryRunPlan(prompt, skill, maxSteps);
    for (const item of planned) {
      if (steps.length >= maxSteps + 3) break;
      if (item.tier === 'write' || item.tier === 'destructive') {
        const decision = decideApproval(config.approvalMode, {
          action: item.action,
          tier: item.tier,
          detail: item.detail,
        });
        steps.push({
          index: steps.length + 1,
          kind: 'approval',
          message: decision.reason,
        });
        if (!decision.allowed) break;
      }
      steps.push({
        index: steps.length + 1,
        kind: item.kind,
        message: item.message,
      });
    }

    await mcp.disconnect();
    return {
      steps,
      summary: `Dry-run complete (${steps.length} steps). Provider=${config.provider} model=${config.model}`,
    };
  }

  const reply = await provider.chat([
    {
      role: 'system',
      content: skill
        ? `You are The Robot. Follow skill "${skill.meta.name}":\n${skill.body}`
        : 'You are The Robot, a careful local agent.',
    },
    { role: 'user', content: prompt },
  ]);

  steps.push({
    index: steps.length + 1,
    kind: 'provider',
    message: reply.content,
  });

  const tools = await mcp.listTools();
  steps.push({
    index: steps.length + 1,
    kind: 'tool',
    message:
      tools.length === 0
        ? 'MCP: no tools registered (stub client)'
        : `MCP tools: ${tools.map((t) => t.name).join(', ')}`,
  });

  await mcp.disconnect();
  return {
    steps,
    summary: `Session complete. model=${reply.model}`,
  };
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
