import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve a user-supplied path under workspaceRoot. Rejects escapes.
 */
export function resolveInWorkspace(workspaceRoot: string, userPath: string): string {
  const root = path.resolve(workspaceRoot);
  const raw = (userPath || '.').trim() || '.';
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes ROBOT_WORKSPACE (${root}): ${userPath}`);
  }
  return candidate;
}

export function assertInsideWorkspace(workspaceRoot: string, absolutePath: string): void {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(absolutePath);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes ROBOT_WORKSPACE (${root}): ${absolutePath}`);
  }
}

export async function ensureWorkspace(workspaceRoot: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  await fs.mkdir(root, { recursive: true });
  return root;
}
