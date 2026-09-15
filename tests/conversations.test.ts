import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { ConversationStore } from '../src/core/conversations.js';
import { loadConfig } from '../src/core/config.js';
import { createApiServer } from '../src/server/api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('ConversationStore', () => {
  let tmp: string;
  let store: ConversationStore;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-conv-'));
    store = new ConversationStore(tmp);
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('upserts, lists, gets, deletes', async () => {
    const saved = await store.upsert({
      id: 'conv_test1',
      title: 'Hello',
      dryRun: true,
      updatedAt: Date.now(),
      messages: [
        { id: 'm1', role: 'user', content: 'hi', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'hello', createdAt: 2 },
      ],
    });
    assert.equal(saved.id, 'conv_test1');
    assert.equal(saved.messages.length, 2);

    const list = await store.list();
    assert.ok(list.some((c) => c.id === 'conv_test1' && c.messageCount === 2));

    const got = await store.get('conv_test1');
    assert.ok(got);
    assert.equal(got!.title, 'Hello');

    const ok = await store.delete('conv_test1');
    assert.equal(ok, true);
    assert.equal(await store.get('conv_test1'), null);
  });

  it('rejects invalid payloads', async () => {
    await assert.rejects(() => store.upsert({ title: 'no id' }), /Invalid conversation/);
  });
});

describe('Conversations API', () => {
  let server: Server;
  let base: string;
  let dataDir: string;

  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-api-conv-'));
    const config = loadConfig({
      skillsDir: path.join(root, 'skills'),
      routinesDir: path.join(root, 'routines'),
      dataDir,
      maxSteps: 4,
      approvalMode: 'auto-approve',
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
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('GET/POST/DELETE /api/conversations', async () => {
    const empty = await fetch(`${base}/api/conversations`);
    assert.equal(empty.status, 200);
    const emptyBody = (await empty.json()) as { conversations: unknown[] };
    assert.equal(emptyBody.conversations.length, 0);

    const upsert = await fetch(`${base}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'conv_api1',
        title: 'API chat',
        dryRun: true,
        updatedAt: Date.now(),
        messages: [{ id: 'u1', role: 'user', content: 'ping', createdAt: Date.now() }],
      }),
    });
    assert.equal(upsert.status, 200);

    const list = await fetch(`${base}/api/conversations`);
    const listBody = (await list.json()) as { conversations: Array<{ id: string }> };
    assert.ok(listBody.conversations.some((c) => c.id === 'conv_api1'));

    const one = await fetch(`${base}/api/conversations/conv_api1`);
    assert.equal(one.status, 200);
    const oneBody = (await one.json()) as { conversation: { title: string } };
    assert.equal(oneBody.conversation.title, 'API chat');

    const del = await fetch(`${base}/api/conversations/conv_api1`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const gone = await fetch(`${base}/api/conversations/conv_api1`);
    assert.equal(gone.status, 404);
  });

  it('health includes conversationsDir', async () => {
    const res = await fetch(`${base}/api/health`);
    const body = (await res.json()) as { conversationsDir?: string; dataDir?: string };
    assert.ok(body.dataDir?.includes(dataDir) || body.dataDir === dataDir);
    assert.ok(body.conversationsDir?.includes('conversations'));
  });
});
