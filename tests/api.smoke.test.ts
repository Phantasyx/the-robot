import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiServer } from '../src/server/api.js';
import { loadConfig } from '../src/core/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('API smoke', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const config = loadConfig({
      skillsDir: path.join(root, 'skills'),
      routinesDir: path.join(root, 'routines'),
      maxSteps: 4,
      approvalMode: 'prompt',
    });
    server = createApiServer({ config });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('GET /api/health', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      product: string;
      skillsLoaded: number;
      ollama: { ok: boolean; detail: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.product, 'The Robot');
    assert.ok(body.skillsLoaded >= 2);
    assert.ok(typeof body.ollama.ok === 'boolean');
    assert.ok(body.ollama.detail.length > 0);
  });

  it('GET /api/skills and /api/routines', async () => {
    const skillsRes = await fetch(`${base}/api/skills`);
    const routinesRes = await fetch(`${base}/api/routines`);
    assert.equal(skillsRes.status, 200);
    assert.equal(routinesRes.status, 200);
    const skills = (await skillsRes.json()) as { skills: unknown[] };
    const routines = (await routinesRes.json()) as { routines: unknown[] };
    assert.ok(skills.skills.length >= 2);
    assert.ok(routines.routines.length >= 2);
  });

  it('POST /api/chat dry-run', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'summarize notes in ./notes',
        dryRun: true,
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { summary: string; steps: unknown[] };
    assert.match(body.summary, /Dry-run complete/);
    assert.ok(body.steps.length >= 2);
  });

  it('POST /api/chat/stream dry-run emits SSE events', async () => {
    const res = await fetch(`${base}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        prompt: 'summarize notes in ./notes',
        dryRun: true,
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"type":"step"/);
    assert.match(text, /"type":"done"/);
  });

  it('POST /api/chat/stream pauses for approval then continues', async () => {
    const controller = new AbortController();
    const resPromise = fetch(`${base}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        prompt: 'organize files in tmp',
        dryRun: true,
        skill: 'local-file-ops',
      }),
      signal: controller.signal,
    });

    // Read stream until approval_required
    const res = await resPromise;
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let approvalId = '';

    const readUntilApproval = async () => {
      while (!approvalId) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as { type?: string; id?: string };
            if (ev.type === 'approval_required' && ev.id) {
              approvalId = ev.id;
              return;
            }
          } catch {
            /* ignore */
          }
        }
      }
    };

    await Promise.race([
      readUntilApproval(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for approval')), 5000)),
    ]);
    assert.ok(approvalId, 'expected approval_required event');

    const approveRes = await fetch(`${base}/api/approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(approveRes.status, 200);

    // Drain remaining stream
    let rest = buffer;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    assert.match(rest, /"type":"done"/);
  });


  it('POST /api/chat dry-run accepts history', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'list the directory .',
        dryRun: true,
        history: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { summary: string; steps: Array<{ message: string }> };
    assert.match(body.summary, /history=2/);
    const joined = body.steps.map((s) => s.message).join('\n');
    assert.match(joined, /Conversation context|2 messages|prior/i);
  });

  it('POST /api/chat live without Ollama returns error', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'hello',
        dryRun: false,
      }),
    });
    // Ollama is down in CI/sandbox → 502 with helpful message
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Ollama|reachable|offline|ECONNREFUSED|fetch/i);
  });
});
