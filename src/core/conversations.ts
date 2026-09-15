import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  summary?: string;
  /** Activity steps — kept for UI replay; may be large. */
  steps?: unknown[];
  error?: boolean;
  createdAt: number;
}

export interface StoredConversation {
  id: string;
  title: string;
  messages: StoredMessage[];
  updatedAt: number;
  dryRun: boolean;
  skill?: string;
  routine?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  dryRun: boolean;
  messageCount: number;
  skill?: string;
  routine?: string;
}

export function defaultDataDir(): string {
  if (process.env.ROBOT_DATA_DIR?.trim()) {
    return path.resolve(process.env.ROBOT_DATA_DIR.trim());
  }
  return path.join(os.homedir(), '.the-robot');
}

export function conversationsDir(dataDir = defaultDataDir()): string {
  return path.join(dataDir, 'conversations');
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function fileFor(id: string, dir: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe) throw new Error('Invalid conversation id');
  return path.join(dir, `${safe}.json`);
}

function normalizeConversation(raw: unknown): StoredConversation | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !c.id.trim()) return null;
  const messages = Array.isArray(c.messages)
    ? (c.messages as StoredMessage[])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({
          id: String(m.id || `msg_${m.createdAt || Date.now()}`),
          role: m.role as 'user' | 'assistant',
          content: String(m.content ?? ''),
          summary: m.summary ? String(m.summary) : undefined,
          steps: Array.isArray(m.steps) ? m.steps : undefined,
          error: Boolean(m.error) || undefined,
          createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
        }))
    : [];
  return {
    id: c.id.trim(),
    title: String(c.title ?? 'New chat'),
    messages,
    updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
    dryRun: c.dryRun !== false,
    skill: typeof c.skill === 'string' ? c.skill : undefined,
    routine: typeof c.routine === 'string' ? c.routine : undefined,
  };
}

export class ConversationStore {
  readonly dir: string;

  constructor(dataDir?: string) {
    this.dir = conversationsDir(dataDir ?? defaultDataDir());
  }

  async list(): Promise<ConversationSummary[]> {
    await ensureDir(this.dir);
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: ConversationSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')) as unknown;
        const c = normalizeConversation(raw);
        if (!c) continue;
        out.push({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          dryRun: c.dryRun,
          messageCount: c.messages.length,
          skill: c.skill,
          routine: c.routine,
        });
      } catch {
        /* skip corrupt */
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  async get(id: string): Promise<StoredConversation | null> {
    await ensureDir(this.dir);
    try {
      const raw = JSON.parse(await fs.readFile(fileFor(id, this.dir), 'utf8')) as unknown;
      return normalizeConversation(raw);
    } catch {
      return null;
    }
  }

  async upsert(input: unknown): Promise<StoredConversation> {
    const c = normalizeConversation(input);
    if (!c) throw new Error('Invalid conversation payload');
    await ensureDir(this.dir);
    c.updatedAt = typeof c.updatedAt === 'number' ? c.updatedAt : Date.now();
    const target = fileFor(c.id, this.dir);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(c, null, 2), 'utf8');
    await fs.rename(tmp, target);
    return c;
  }

  async delete(id: string): Promise<boolean> {
    await ensureDir(this.dir);
    try {
      await fs.unlink(fileFor(id, this.dir));
      return true;
    } catch {
      return false;
    }
  }
}

let singleton: ConversationStore | undefined;

export function getConversationStore(dataDir?: string): ConversationStore {
  if (dataDir) return new ConversationStore(dataDir);
  if (!singleton) singleton = new ConversationStore();
  return singleton;
}
