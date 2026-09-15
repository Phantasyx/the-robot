import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import { runSession } from '../src/core/runtime.js';
import {
  executeBuiltinTool,
  planToolsFromPrompt,
  resolveInWorkspace,
} from '../src/tools/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Built-in tools + history', () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-ws-'));
    await fs.writeFile(path.join(tmp, 'hello.txt'), 'hello robot\n', 'utf8');
    await fs.mkdir(path.join(tmp, 'notes'));
    await fs.writeFile(path.join(tmp, 'notes', 'a.md'), '# note\n', 'utf8');
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('sandbox rejects path escape', () => {
    assert.throws(() => resolveInWorkspace(tmp, '../outside.txt'), /escapes ROBOT_WORKSPACE/);
  });

  it('list_dir and read_file work inside workspace', async () => {
    const list = await executeBuiltinTool(
      { name: 'list_dir', args: { path: '.' }, tier: 'read' },
      { workspaceRoot: tmp, enableRunCommand: false },
    );
    assert.equal(list.ok, true);
    assert.match(list.content, /hello\.txt/);

    const read = await executeBuiltinTool(
      { name: 'read_file', args: { path: 'hello.txt' }, tier: 'read' },
      { workspaceRoot: tmp, enableRunCommand: false },
    );
    assert.equal(read.ok, true);
    assert.match(read.content, /hello robot/);
  });

  it('write_file is sandboxed and creates content', async () => {
    const result = await executeBuiltinTool(
      {
        name: 'write_file',
        args: { path: 'out/robot.txt', content: 'written\n' },
        tier: 'write',
      },
      { workspaceRoot: tmp, enableRunCommand: false },
    );
    assert.equal(result.ok, true);
    const text = await fs.readFile(path.join(tmp, 'out', 'robot.txt'), 'utf8');
    assert.equal(text, 'written\n');
  });

  it('planner infers list_dir / write_file from prompts', () => {
    const listed = planToolsFromPrompt('list the contents of notes', { enableRunCommand: false });
    assert.ok(listed.some((c) => c.name === 'list_dir'));

    const written = planToolsFromPrompt('write file demo.txt with content "hi"', {
      enableRunCommand: false,
    });
    assert.ok(written.some((c) => c.name === 'write_file'));
  });

  it('dry-run acknowledges prior conversation turns', async () => {
    const config = loadConfig({
      skillsDir: path.join(root, 'skills'),
      routinesDir: path.join(root, 'routines'),
      workspaceRoot: tmp,
      approvalMode: 'auto-approve',
      maxSteps: 8,
    });
    const result = await runSession(config, {
      prompt: 'list the directory .',
      dryRun: true,
      history: [
        { role: 'user', content: 'My project is called Orchid' },
        { role: 'assistant', content: 'Got it — Orchid.' },
      ],
    });
    const joined = result.steps.map((s) => s.message).join('\n');
    assert.match(joined, /prior|Conversation context|2 messages/i);
    assert.match(joined, /Orchid|last user/i);
    assert.ok(result.steps.some((s) => s.kind === 'tool' && s.tool?.name === 'list_dir'));
    assert.match(result.summary, /history=2/);
  });

  it('dry-run write plans without touching disk', async () => {
    const config = loadConfig({
      skillsDir: path.join(root, 'skills'),
      routinesDir: path.join(root, 'routines'),
      workspaceRoot: tmp,
      approvalMode: 'auto-approve',
      maxSteps: 8,
    });
    const before = await fs.readdir(tmp);
    const planned = await runSession(config, {
      prompt: 'write file side-effect.txt with content "nope"',
      dryRun: true,
    });
    assert.ok(planned.steps.some((s) => s.tool?.name === 'write_file' && s.tool.planned));
    const after = await fs.readdir(tmp);
    assert.deepEqual(after.sort(), before.sort());
  });

  it('live mode executes tools after mocked Ollama reply', async () => {
    const config = loadConfig({
      skillsDir: path.join(root, 'skills'),
      routinesDir: path.join(root, 'routines'),
      workspaceRoot: tmp,
      approvalMode: 'auto-approve',
      ollamaHost: 'http://127.0.0.1:11434',
      maxSteps: 10,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3.2' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/chat')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          messages?: Array<{ role: string; content: string }>;
          stream?: boolean;
        };
        const msgs = body.messages ?? [];
        const hasHistory = msgs.some((m) => m.content.includes('Orchid'));
        const hasTools = msgs.some((m) => /Tool results/i.test(m.content));
        const content = hasTools
          ? 'Listed notes after tools.'
          : hasHistory
            ? 'Orchid notes listing coming up.'
            : 'Working on it.';
        // Agent loop uses non-streaming chat for tool rounds
        if (body.stream === false) {
          return new Response(
            JSON.stringify({
              model: 'llama3.2',
              message: { role: 'assistant', content },
              done: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const payload = `${JSON.stringify({ message: { content }, done: false })}\n${JSON.stringify({
          message: { content: '' },
          done: true,
        })}\n`;
        return new Response(payload, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const events: string[] = [];
      const result = await runSession(config, {
        prompt: 'list the contents of notes',
        dryRun: false,
        history: [
          { role: 'user', content: 'Remember the project Orchid' },
          { role: 'assistant', content: 'Remembered Orchid.' },
        ],
        onEvent: (e) => events.push(e.type),
      });
      assert.ok(result.steps.some((s) => s.kind === 'tool_result' && s.tool?.name === 'list_dir'));
      assert.ok(result.steps.some((s) => s.kind === 'tool_result' && s.tool?.ok));
      assert.match(result.summary, /history=2/);
      assert.ok(events.includes('token'));
      assert.ok(events.includes('done'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
