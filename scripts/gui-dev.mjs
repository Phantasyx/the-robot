#!/usr/bin/env node
/**
 * Start local API (8787) + Vite GUI (5173) for development.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function run(command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: opts.cwd ?? root,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
    shell: process.platform === 'win32',
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else if (code && code !== 0) shutdown(code);
  });
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

console.log('The Robot GUI (dev): API :8787 + Vite :5173');
run('npx', ['tsx', 'src/server/index.ts'], { cwd: root });
run('npm', ['run', 'dev', '--prefix', 'gui'], { cwd: root });
