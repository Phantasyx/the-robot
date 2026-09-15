import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ApprovalTier } from '../core/skills.js';
import { assertInsideWorkspace, resolveInWorkspace } from './sandbox.js';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from './types.js';

const execFileAsync = promisify(execFile);

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'list_dir',
    description: 'List entries in a directory under the workspace root',
    tier: 'read',
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file under the workspace root',
    tier: 'read',
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file under the workspace root',
    tier: 'write',
  },
  {
    name: 'run_command',
    description:
      'Run an argv-only process with cwd=workspace (no shell). Off by default — set ROBOT_ENABLE_RUN_COMMAND=1. Prefer args.argv; command string rejects shell metacharacters. Hard timeout applies.',
    tier: 'destructive',
    optional: true,
  },
];

export function listAvailableTools(ctx: Pick<ToolContext, 'enableRunCommand'>): ToolDefinition[] {
  return BUILTIN_TOOLS.filter((t) => !t.optional || ctx.enableRunCommand);
}

export function getToolTier(name: string): ApprovalTier {
  const def = BUILTIN_TOOLS.find((t) => t.name === name);
  return def?.tier ?? 'destructive';
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

export async function executeBuiltinTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const available = listAvailableTools(ctx);
  if (!available.some((t) => t.name === call.name)) {
    return { ok: false, content: `Unknown or disabled tool: ${call.name}` };
  }

  try {
    switch (call.name) {
      case 'list_dir':
        return await toolListDir(call.args, ctx);
      case 'read_file':
        return await toolReadFile(call.args, ctx);
      case 'write_file':
        return await toolWriteFile(call.args, ctx);
      case 'run_command':
        return await toolRunCommand(call.args, ctx);
      default:
        return { ok: false, content: `Unhandled tool: ${call.name}` };
    }
  } catch (err) {
    return {
      ok: false,
      content: err instanceof Error ? err.message : String(err),
    };
  }
}

async function toolListDir(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rel = asString(args.path, '.');
  const abs = resolveInWorkspace(ctx.workspaceRoot, rel);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `${e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other'}\t${e.name}`);
  const display = path.relative(ctx.workspaceRoot, abs) || '.';
  return {
    ok: true,
    path: abs,
    content: lines.length
      ? `list_dir ${display}\n${lines.join('\n')}`
      : `list_dir ${display}\n(empty)`,
  };
}

async function toolReadFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rel = asString(args.path);
  if (!rel) return { ok: false, content: 'read_file requires path' };
  const abs = resolveInWorkspace(ctx.workspaceRoot, rel);
  const max = ctx.maxReadBytes ?? 256_000;
  const st = await fs.stat(abs);
  if (!st.isFile()) return { ok: false, content: `Not a file: ${rel}`, path: abs };
  if (st.size > max) {
    return {
      ok: false,
      content: `File too large (${st.size} bytes > ${max}): ${rel}`,
      path: abs,
    };
  }
  const text = await fs.readFile(abs, 'utf8');
  const display = path.relative(ctx.workspaceRoot, abs) || rel;
  return {
    ok: true,
    path: abs,
    content: `read_file ${display} (${text.length} chars)\n${text}`,
  };
}

async function toolWriteFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const rel = asString(args.path);
  const content = asString(args.content);
  if (!rel) return { ok: false, content: 'write_file requires path' };
  const abs = resolveInWorkspace(ctx.workspaceRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  assertInsideWorkspace(ctx.workspaceRoot, abs);
  await fs.writeFile(abs, content, 'utf8');
  const display = path.relative(ctx.workspaceRoot, abs) || rel;
  return {
    ok: true,
    path: abs,
    content: `write_file ${display} (${content.length} chars) ok`,
  };
}

async function toolRunCommand(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.enableRunCommand) {
    return { ok: false, content: 'run_command disabled (set ROBOT_ENABLE_RUN_COMMAND=1)' };
  }

  // Prefer argv-only. Fall back to a simple command string with no shell features.
  let file: string;
  let argv: string[];
  if (Array.isArray(args.argv) && args.argv.length > 0) {
    file = String(args.argv[0]).trim();
    argv = args.argv.slice(1).map((a) => String(a));
  } else {
    const command = asString(args.command).trim();
    if (!command) {
      return {
        ok: false,
        content: 'run_command requires argv (preferred) or a simple command string',
      };
    }
    if (SHELL_META.test(command)) {
      return {
        ok: false,
        content:
          'run_command rejects shell metacharacters (| & ; < > $ ` ( ) { } etc). Pass argv: ["cmd","arg1",...] instead.',
      };
    }
    const parts = splitCommand(command);
    file = parts[0] ?? '';
    argv = parts.slice(1);
  }
  if (!file) return { ok: false, content: 'empty command' };

  const cwd = path.resolve(ctx.workspaceRoot);
  const timeout = ctx.commandTimeoutMs ?? 15_000;
  try {
    const { stdout, stderr } = await execFileAsync(file, argv, {
      cwd,
      timeout,
      maxBuffer: 512_000,
      env: sanitizeEnv(process.env, cwd),
      signal: ctx.signal,
      // Never invoke a shell — execFile only.
      shell: false,
    });
    const out = [stdout, stderr].filter((s) => s && s.trim()).join('\n').trim();
    return {
      ok: true,
      content: out || `(run_command ok: ${file}${argv.length ? ' ' + argv.join(' ') : ''})`,
    };
  } catch (err) {
    const e = err as {
      message?: string;
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    if (e.killed || e.code === 'ETIMEDOUT') {
      return {
        ok: false,
        content: `run_command timed out after ${timeout}ms: ${file} ${argv.join(' ')}`.trim(),
      };
    }
    const bits = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
    return {
      ok: false,
      content: bits || `run_command failed (code ${e.code ?? '?'})`,
    };
  }
}

/** Characters that imply a shell — not allowed in the command-string fallback. */
const SHELL_META = /[|&;<>$`\\(){}\[\]!\n\r]|\$\(|&&|\|\||>>|<</;

function sanitizeEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, PWD: cwd };
  // Drop interactive shell hooks that could surprise argv-only runs.
  delete next.PROMPT_COMMAND;
  delete next.BASH_ENV;
  delete next.ENV;
  return next;
}

/** Minimal split for demo commands — not a full shell parser. */
function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Heuristic planner: map natural-language prompts onto built-in tools.
 * Good enough for dry-run demos and offline tool paths without model tool-calling.
 */
export function planToolsFromPrompt(
  prompt: string,
  ctx: Pick<ToolContext, 'enableRunCommand'>,
): ToolCall[] {
  const lower = prompt.toLowerCase();
  const calls: ToolCall[] = [];
  const pathGuess = extractPathHint(prompt);

  const wantsList =
    /\b(list|ls|dir|directory|folder|contents|what.?s in)\b/i.test(prompt) ||
    /\blist_dir\b/i.test(prompt);
  const wantsRead =
    /\b(read|cat|open|show|inspect)\b.{0,40}\b(file|notes?|\.md|\.txt|\.json)\b/i.test(prompt) ||
    /\bread_file\b/i.test(prompt) ||
    (/\bread\b/i.test(prompt) && Boolean(pathGuess && /\.\w+$/.test(pathGuess)));
  const wantsWrite =
    /\b(write|create|save|overwrite|append)\b/i.test(prompt) ||
    /\bwrite_file\b/i.test(prompt);
  const wantsRun =
    ctx.enableRunCommand &&
    (/\b(run_command|run command|shell|execute)\b/i.test(prompt) ||
      /\brun\s+[`'"]?\w+/i.test(prompt));

  if (wantsList) {
    const listPath =
      pathGuess && !/\.\w+$/.test(pathGuess) ? pathGuess : wantsRead ? '.' : pathGuess || '.';
    calls.push({
      name: 'list_dir',
      args: { path: listPath },
      tier: 'read',
    });
  }

  if (wantsRead) {
    calls.push({
      name: 'read_file',
      args: { path: pathGuess && /\.\w+$/.test(pathGuess) ? pathGuess : pathGuess || 'README.md' },
      tier: 'read',
    });
  }

  if (wantsWrite) {
    const target =
      pathGuess && /\.\w+$/.test(pathGuess)
        ? pathGuess
        : extractWriteTarget(prompt) || 'robot-out.txt';
    const content = extractWriteContent(prompt) || `# written by The Robot\nprompt: ${prompt.slice(0, 120)}\n`;
    calls.push({
      name: 'write_file',
      args: { path: target, content },
      tier: 'write',
    });
  }

  if (wantsRun) {
    const cmd = extractRunCommand(prompt) || 'pwd';
    calls.push({
      name: 'run_command',
      args: { command: cmd },
      tier: 'destructive',
    });
  }

  // Skill-ish fallback: "organize / cleanup" → list then propose write plan (list only here)
  if (calls.length === 0 && /\b(organiz|cleanup|clean up|rename|move files|file ops)\b/i.test(lower)) {
    calls.push({
      name: 'list_dir',
      args: { path: pathGuess || '.' },
      tier: 'read',
    });
  }

  return calls;
}

function extractPathHint(prompt: string): string | undefined {
  const m =
    prompt.match(/(?:^|[\s`"'])(\.\/[\w./-]+|[\w.-]+\/[\w./-]+|[\w.-]+\.(?:md|txt|json|ts|js|csv))(?=$|[\s`"',:])/i) ||
    prompt.match(/\b(?:in|under|from|to|at|path)\s+([./\w-]+)/i);
  if (!m) return undefined;
  return m[1].replace(/^['"`]|['"`]$/g, '');
}

function extractWriteTarget(prompt: string): string | undefined {
  const m = prompt.match(
    /\b(?:write|create|save)(?:\s+(?:a|the))?\s+(?:file\s+)?(?:to\s+|into\s+|at\s+)?([./\w-]+\.\w+)/i,
  );
  return m?.[1];
}

function extractWriteContent(prompt: string): string | undefined {
  const m =
    prompt.match(/\b(?:with(?:\s+content)?|containing|content)\s+["']([^"']+)["']/i) ||
    prompt.match(/:\s*["']([^"']+)["']\s*$/);
  return m?.[1];
}

function extractRunCommand(prompt: string): string | undefined {
  const m =
    prompt.match(/\brun_command\s+(.+)$/i) ||
    prompt.match(/\brun(?:\s+command)?\s+[`'"]([^`'"]+)[`'"]/i) ||
    prompt.match(/\bexecute\s+[`'"]([^`'"]+)[`'"]/i);
  return m?.[1]?.trim();
}

export function formatToolCall(call: ToolCall): string {
  const argStr = Object.entries(call.args)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      const clipped = s.length > 80 ? `${s.slice(0, 77)}…` : s;
      return `${k}=${clipped}`;
    })
    .join(', ');
  return `${call.name}(${argStr})`;
}
