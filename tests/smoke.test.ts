import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideApproval, resolveApproval } from '../src/approvals/gate.js';
import { ApprovalBroker } from '../src/approvals/broker.js';
import { loadConfig } from '../src/core/config.js';
import { loadRoutines } from '../src/core/routines.js';
import { runSession } from '../src/core/runtime.js';
import { loadSkills } from '../src/core/skills.js';
import { OllamaProvider } from '../src/providers/ollama.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('The Robot smoke', () => {
  it('loads example skills', async () => {
    const skills = await loadSkills(path.join(root, 'skills'));
    assert.ok(skills.length >= 2);
    const names = skills.map((s) => s.meta.name);
    assert.ok(names.includes('summarize-notes'));
    assert.ok(names.includes('local-file-ops'));
  });

  it('loads example routines', async () => {
    const routines = await loadRoutines(path.join(root, 'routines'));
    assert.ok(routines.length >= 2);
    assert.ok(routines.some((r) => r.schedule));
    assert.ok(routines.some((r) => r.trigger));
  });

  it('dry-run session produces steps', async () => {
    const config = loadConfig({
      skillsDir: path.join(root, 'skills'),
      routinesDir: path.join(root, 'routines'),
      maxSteps: 4,
    });
    const result = await runSession(config, {
      prompt: 'summarize notes in ./notes',
      dryRun: true,
      maxSteps: 4,
    });
    assert.ok(result.steps.length >= 2);
    assert.match(result.summary, /Dry-run complete/);
  });

  it('approval gate denies destructive in deny mode', () => {
    const d = decideApproval('deny', {
      action: 'delete-file',
      tier: 'destructive',
    });
    assert.equal(d.allowed, false);
  });

  it('interactive resolveApproval uses handler in prompt mode', async () => {
    const d = await resolveApproval(
      'prompt',
      { action: 'write-file', tier: 'write' },
      async () => ({ allowed: false, reason: 'user denied' }),
    );
    assert.equal(d.allowed, false);
    assert.match(d.reason, /user denied/);
  });

  it('approval broker resolves pending ids', async () => {
    const broker = new ApprovalBroker();
    const { id, promise } = broker.create({ action: 'test', tier: 'write' }, 2000);
    assert.ok(broker.get(id));
    const ok = broker.resolve(id, true);
    assert.equal(ok, true);
    const d = await promise;
    assert.equal(d.allowed, true);
  });

  it('ollama ping reports unreachable when down', async () => {
    const p = new OllamaProvider({ host: 'http://127.0.0.1:9', model: 'llama3.2' });
    const ping = await p.ping();
    assert.equal(ping.ok, false);
    assert.match(ping.detail, /not reachable/i);
  });

  it('live session fails gracefully when Ollama is down', async () => {
    const config = loadConfig({
      skillsDir: path.join(root, 'skills'),
      routinesDir: path.join(root, 'routines'),
      ollamaHost: 'http://127.0.0.1:9',
    });
    await assert.rejects(
      () =>
        runSession(config, {
          prompt: 'hello robot',
          dryRun: false,
        }),
      /Ollama|reachable|fetch|ECONNREFUSED/i,
    );
  });
});
