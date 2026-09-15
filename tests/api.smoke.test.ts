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
    const body = (await res.json()) as { ok: boolean; product: string; skillsLoaded: number };
    assert.equal(body.ok, true);
    assert.equal(body.product, 'The Robot');
    assert.ok(body.skillsLoaded >= 2);
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
});
