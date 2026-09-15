#!/usr/bin/env node
import { loadConfig } from '../core/config.js';
import { loadRoutines } from '../core/routines.js';
import { runSession } from '../core/runtime.js';
import { loadSkills } from '../core/skills.js';
import { createProvider } from '../providers/ollama.js';
import { banner, helpText } from './banner.js';

interface CliArgs {
  command: string;
  promptParts: string[];
  dryRun: boolean;
  skill?: string;
  routine?: string;
  maxSteps?: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const out: CliArgs = {
    command: 'help',
    promptParts: [],
    dryRun: false,
    help: false,
  };

  if (args.length === 0) {
    out.help = true;
    return out;
  }

  let i = 0;
  const first = args[0];
  if (first === '-h' || first === '--help' || first === 'help') {
    out.help = true;
    return out;
  }

  out.command = first;
  i = 1;

  while (i < args.length) {
    const a = args[i];
    if (a === '--dry-run') {
      out.dryRun = true;
      i += 1;
    } else if (a === '--skill' && args[i + 1]) {
      out.skill = args[i + 1];
      i += 2;
    } else if (a === '--routine' && args[i + 1]) {
      out.routine = args[i + 1];
      i += 2;
    } else if (a === '--max-steps' && args[i + 1]) {
      out.maxSteps = Number(args[i + 1]);
      i += 2;
    } else if (a === '-h' || a === '--help') {
      out.help = true;
      i += 1;
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      out.promptParts.push(a);
      i += 1;
    }
  }

  return out;
}

async function cmdSkillsList(): Promise<void> {
  const config = loadConfig();
  const skills = await loadSkills(config.skillsDir);
  if (skills.length === 0) {
    console.log('No skills found in', config.skillsDir);
    return;
  }
  console.log(`Skills (${skills.length}) — ${config.skillsDir}\n`);
  for (const s of skills) {
    console.log(`  ${s.meta.name}`);
    console.log(`    ${s.meta.description || '(no description)'}`);
    console.log(
      `    approval=${s.meta.approval}` +
        (s.meta.triggers.length ? `  triggers=${s.meta.triggers.join(',')}` : ''),
    );
    console.log('');
  }
}

async function cmdRoutinesList(): Promise<void> {
  const config = loadConfig();
  const routines = await loadRoutines(config.routinesDir);
  if (routines.length === 0) {
    console.log('No routines found in', config.routinesDir);
    return;
  }
  console.log(`Routines (${routines.length}) — ${config.routinesDir}\n`);
  for (const r of routines) {
    const when = r.schedule ? `cron ${r.schedule}` : r.trigger ? `trigger ${r.trigger}` : 'manual';
    console.log(`  ${r.name}  [${r.enabled === false ? 'disabled' : 'enabled'}]`);
    console.log(`    ${r.description || '(no description)'}`);
    console.log(`    ${when} → skill ${r.skill}`);
    console.log(`    prompt: ${r.prompt}`);
    console.log('');
  }
}

async function cmdDoctor(): Promise<void> {
  const config = loadConfig();
  console.log(banner());
  console.log('Doctor\n');
  console.log(`  provider:       ${config.provider}`);
  console.log(`  ollama host:    ${config.ollamaHost}`);
  console.log(`  model:          ${config.model}`);
  console.log(`  approval mode:  ${config.approvalMode}`);
  console.log(`  skills dir:     ${config.skillsDir}`);
  console.log(`  routines dir:   ${config.routinesDir}`);
  console.log('');

  const skills = await loadSkills(config.skillsDir);
  const routines = await loadRoutines(config.routinesDir);
  console.log(`  skills loaded:  ${skills.length}`);
  console.log(`  routines:       ${routines.length}`);
  console.log('');

  const provider = createProvider({ host: config.ollamaHost, model: config.model });
  const ping = await provider.ping();
  console.log(`  ollama:         ${ping.ok ? 'ok' : 'unreachable'}`);
  console.log(`                  ${ping.detail}`);
  console.log('');
}

async function cmdRun(args: CliArgs): Promise<void> {
  const config = loadConfig({
    maxSteps: args.maxSteps ?? 5,
  });
  const prompt = args.promptParts.join(' ').trim();

  console.log(banner());
  if (args.dryRun) {
    console.log('Mode: dry-run (no live model / tool side effects)\n');
  }

  const result = await runSession(config, {
    prompt,
    dryRun: args.dryRun,
    skillName: args.skill,
    routineName: args.routine,
    maxSteps: args.maxSteps,
  });

  for (const step of result.steps) {
    console.log(`[${step.index}] ${step.kind.padEnd(8)} ${step.message}`);
  }
  console.log('');
  console.log(result.summary);
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  if (args.help || args.command === 'help') {
    console.log(helpText());
    return;
  }

  try {
    switch (args.command) {
      case 'run':
        await cmdRun(args);
        break;
      case 'skills':
        if (args.promptParts[0] === 'list' || args.promptParts.length === 0) {
          await cmdSkillsList();
        } else {
          console.error('Usage: robot skills list');
          process.exitCode = 1;
        }
        break;
      case 'routines':
        if (args.promptParts[0] === 'list' || args.promptParts.length === 0) {
          await cmdRoutinesList();
        } else {
          console.error('Usage: robot routines list');
          process.exitCode = 1;
        }
        break;
      case 'doctor':
        await cmdDoctor();
        break;
      default:
        console.error(`Unknown command: ${args.command}\n`);
        console.log(helpText());
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

main();
