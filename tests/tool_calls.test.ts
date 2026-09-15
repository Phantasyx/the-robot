import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import { runSession } from '../src/core/runtime.js';
import {
  extractToolCallsFromContent,
  parseModelToolCalls,
  toOllamaTools,
} from '../src/tools/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Tool-call parsing', () => {
  it('parses Ollama-native tool_calls', () => {
    const calls = parseModelToolCalls([
      {
        function: {
          name: 'list_dir',
          arguments: { path: 'notes' },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"notes/a.md"}',
        },
      },
    ]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, 'list_dir');
    assert.equal(calls[0].args.path, 'notes');
    assert.equal(calls[0].tier, 'read');
    assert.equal(calls[1].name, 'read_file');
    assert.equal(calls[1].args.path, 'notes/a.md');
  });

  it('extracts tool JSON from assistant content', () => {
    const content = `Sure, I'll list that.

\`\`\`json
{"name":"list_dir","arguments":{"path":"."}}
\`\`\`
`;
    const calls = extractToolCallsFromContent(content);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'list_dir');
  });

  it('builds Ollama tool specs for enabled tools', () => {
    const tools = toOllamaTools({ enableRunCommand: false });
    assert.ok(tools.every((t) => t.type === 'function'));
    assert.ok(tools.some((t) => t.function.name === 'list_dir'));
    assert.ok(!tools.some((t) => t.function.name === 'run_command'));
    const withRun = toOllamaTools({ enableRunCommand: true });
    assert.ok(withRun.some((t) => t.function.name === 'run_command'));
  });
});

describe('Live agent loop with model tool_calls', () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-tc-'));
    await fs.mkdir(path.join(tmp, 'notes'));
    await fs.writeFile(path.join(tmp, 'notes', 'a.md'), '# note\n', 'utf8');
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('executes model tool_calls then finalizes', async () => {
    const config = loadConfig({
      skillsDir: path.join(root, 'skills'),
      routinesDir: path.join(root, 'routines'),
      workspaceRoot: tmp,
      approvalMode: 'auto-approve',
      ollamaHost: 'http://127.0.0.1:11434',
      maxSteps: 12,
      maxToolRounds: 4,
    });

    let chatRound = 0;
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
        chatRound += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          tools?: unknown[];
          messages?: Array<{ role: string; content?: string; tool_name?: string }>;
          stream?: boolean;
        };
        assert.equal(body.stream, false);
        assert.ok(Array.isArray(body.tools) && body.tools.length >= 3);

        if (chatRound === 1) {
          // Model requests a tool
          return new Response(
            JSON.stringify({
              model: 'llama3.2',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    function: {
                      name: 'list_dir',
                      arguments: { path: 'notes' },
                    },
                  },
                ],
              },
              done: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Follow-up: should include a tool result message
        const hasTool = (body.messages ?? []).some((m) => m.role === 'tool');
        assert.ok(hasTool, 'expected tool role message in follow-up');
        return new Response(
          JSON.stringify({
            model: 'llama3.2',
            message: {
              role: 'assistant',
              content: 'Found notes/a.md in the notes folder.',
            },
            done: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const result = await runSession(config, {
        prompt: 'What is in the notes folder?',
        dryRun: false,
      });
      assert.ok(
        result.steps.some(
          (s) => s.kind === 'tool_result' && s.tool?.name === 'list_dir' && s.tool.source === 'model',
        ),
      );
      assert.ok(result.steps.some((s) => s.kind === 'provider' && /notes\/a\.md|Found notes/i.test(s.message)));
      assert.match(result.summary, /model_tools=1/);
      assert.match(result.summary, /heuristic=no/);
      assert.ok(chatRound >= 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('run_command safety', () => {
  it('rejects shell metacharacters in command string', async () => {
    const { executeBuiltinTool } = await import('../src/tools/index.js');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-run-'));
    try {
      const blocked = await executeBuiltinTool(
        {
          name: 'run_command',
          args: { command: 'echo hi && rm -rf /' },
          tier: 'destructive',
        },
        { workspaceRoot: tmp, enableRunCommand: true },
      );
      assert.equal(blocked.ok, false);
      assert.match(blocked.content, /metacharacters|argv/i);

      const ok = await executeBuiltinTool(
        {
          name: 'run_command',
          args: { argv: ['echo', 'hello-robot'] },
          tier: 'destructive',
        },
        { workspaceRoot: tmp, enableRunCommand: true, commandTimeoutMs: 5000 },
      );
      assert.equal(ok.ok, true);
      assert.match(ok.content, /hello-robot/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
