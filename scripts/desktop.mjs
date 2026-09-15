#!/usr/bin/env node
/**
 * Launch Electron against the local GUI.
 * Set ROBOT_DESKTOP_START_API=1 to also spawn start:gui.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const children = [];

function run(command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: opts.cwd ?? root,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
    shell: process.platform === 'win32',
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

let electronBin;
try {
  electronBin = require('electron');
} catch {
  console.error('Electron is not installed.');
  console.error('Install with: npm install --save-dev electron');
  console.error('Or use the web GUI: npm run gui / npm run start:gui');
  console.error('See desktop/README.md');
  process.exit(1);
}

const startApi = process.env.ROBOT_DESKTOP_START_API === '1' || process.argv.includes('--with-api');
const guiUrl = process.env.ROBOT_DESKTOP_URL || 'http://127.0.0.1:8787';

async function waitForHealth(url, attempts = 40) {
  const health = url.replace(/\/$/, '') + '/api/health';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(health);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`API not reachable at ${health}`);
}

async function main() {
  if (startApi) {
    console.log('Starting API + static GUI…');
    run('npx', ['tsx', 'src/server/index.ts', '--static'], { cwd: root });
    await waitForHealth(guiUrl);
  }

  console.log(`Opening The Robot desktop → ${guiUrl}`);
  const child = run(electronBin, [path.join(root, 'desktop/main.cjs')], {
    cwd: root,
    env: { ROBOT_DESKTOP_URL: guiUrl, ELECTRON_RUN_AS_NODE: '' },
  });
  child.on('exit', (code) => shutdown(code ?? 0));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  shutdown(1);
});
