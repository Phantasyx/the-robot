import http from 'node:http';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { globalApprovalBroker } from '../approvals/broker.js';
import type { ApprovalDecision, ApprovalRequest } from '../approvals/gate.js';
import { loadConfig, ROOT, type RobotConfig } from '../core/config.js';
import { getConversationStore } from '../core/conversations.js';
import { loadRoutines } from '../core/routines.js';
import { runSession, type SessionEvent } from '../core/runtime.js';
import { loadSkills } from '../core/skills.js';
import { createProvider } from '../providers/ollama.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export interface ApiServerOptions {
  port?: number;
  host?: string;
  /** Directory of built GUI assets (production). */
  staticDir?: string;
  config?: RobotConfig;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendText(res: http.ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type });
  res.end(text);
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

function withCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse, config: RobotConfig): Promise<void> {
  const skills = await loadSkills(config.skillsDir);
  const routines = await loadRoutines(config.routinesDir);
  const provider = createProvider({ host: config.ollamaHost, model: config.model });
  const ping = await provider.ping();

  sendJson(res, 200, {
    ok: true,
    product: 'The Robot',
    version: '0.1.0',
    provider: config.provider,
    model: config.model,
    ollamaHost: config.ollamaHost,
    approvalMode: config.approvalMode,
    skillsDir: config.skillsDir,
    routinesDir: config.routinesDir,
    workspaceRoot: config.workspaceRoot,
    enableRunCommand: config.enableRunCommand,
    skillsLoaded: skills.length,
    routinesLoaded: routines.length,
    ollama: ping,
    pendingApprovals: globalApprovalBroker.list().length,
    dataDir: config.dataDir,
    conversationsDir: getConversationStore(config.dataDir).dir,
  });
}

async function handleSkills(_req: http.IncomingMessage, res: http.ServerResponse, config: RobotConfig): Promise<void> {
  const skills = await loadSkills(config.skillsDir);
  sendJson(res, 200, {
    skills: skills.map((s) => ({
      name: s.meta.name,
      description: s.meta.description,
      triggers: s.meta.triggers,
      approval: s.meta.approval,
    })),
  });
}

async function handleRoutines(_req: http.IncomingMessage, res: http.ServerResponse, config: RobotConfig): Promise<void> {
  const routines = await loadRoutines(config.routinesDir);
  sendJson(res, 200, { routines });
}

type ChatHistoryItem = { role?: string; content?: string };

type ChatBody = {
  prompt?: string;
  dryRun?: boolean;
  skill?: string;
  routine?: string;
  maxSteps?: number;
  /** Prior turns for multi-turn context (user/assistant). */
  history?: ChatHistoryItem[];
};

function normalizeHistory(raw: ChatHistoryItem[] | undefined) {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((m) => ({
      role: (m.role === 'assistant' || m.role === 'system' ? m.role : 'user') as
        | 'user'
        | 'assistant'
        | 'system',
      content: String(m.content ?? ''),
    }))
    .filter((m) => m.content.trim().length > 0);
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse, config: RobotConfig): Promise<void> {
  const body = await readJsonBody<ChatBody>(req);
  const prompt = (body.prompt ?? '').trim();
  if (!prompt && !body.routine) {
    sendJson(res, 400, { error: 'prompt or routine is required' });
    return;
  }

  try {
    const result = await runSession(config, {
      prompt,
      dryRun: body.dryRun !== false,
      skillName: body.skill || undefined,
      routineName: body.routine || undefined,
      maxSteps: body.maxSteps,
      history: normalizeHistory(body.history),
    });
    sendJson(res, 200, {
      summary: result.summary,
      steps: result.steps,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 502, { error: message });
  }
}

function writeSse(res: http.ServerResponse, event: SessionEvent | { type: string; [k: string]: unknown }): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function handleChatStream(req: http.IncomingMessage, res: http.ServerResponse, config: RobotConfig): Promise<void> {
  const body = await readJsonBody<ChatBody>(req);
  const prompt = (body.prompt ?? '').trim();
  if (!prompt && !body.routine) {
    sendJson(res, 400, { error: 'prompt or routine is required' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const requestApproval = async (approvalReq: ApprovalRequest): Promise<ApprovalDecision> => {
    const { id, promise } = globalApprovalBroker.create(approvalReq);
    writeSse(res, {
      type: 'approval_required',
      id,
      action: approvalReq.action,
      tier: approvalReq.tier,
      detail: approvalReq.detail,
    });
    return promise;
  };

  try {
    await runSession(config, {
      prompt,
      dryRun: body.dryRun !== false,
      skillName: body.skill || undefined,
      routineName: body.routine || undefined,
      maxSteps: body.maxSteps,
      history: normalizeHistory(body.history),
      signal: ac.signal,
      requestApproval: config.approvalMode === 'prompt' ? requestApproval : undefined,
      onEvent: (event) => {
        if (event.type === 'approval_required') return; // emitted via broker path
        writeSse(res, event);
      },
    });
  } catch (err) {
    if (!ac.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      writeSse(res, { type: 'error', message });
    }
  }

  res.write('data: {"type":"close"}\n\n');
  res.end();
}

async function handleApproval(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const body = await readJsonBody<{ decision?: string; reason?: string }>(req);
  const decision = (body.decision ?? '').toLowerCase();
  if (decision !== 'approve' && decision !== 'deny') {
    sendJson(res, 400, { error: 'decision must be approve or deny' });
    return;
  }
  const ok = globalApprovalBroker.resolve(id, decision === 'approve', body.reason);
  if (!ok) {
    sendJson(res, 404, { error: 'Unknown or expired approval id' });
    return;
  }
  sendJson(res, 200, { ok: true, id, decision });
}


async function handleConversationsList(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RobotConfig,
): Promise<void> {
  const store = getConversationStore(config.dataDir);
  const conversations = await store.list();
  sendJson(res, 200, { conversations, dir: store.dir });
}

async function handleConversationGet(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RobotConfig,
  id: string,
): Promise<void> {
  const store = getConversationStore(config.dataDir);
  const conversation = await store.get(id);
  if (!conversation) {
    sendJson(res, 404, { error: 'Conversation not found' });
    return;
  }
  sendJson(res, 200, { conversation });
}

async function handleConversationUpsert(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RobotConfig,
): Promise<void> {
  const body = await readJsonBody<unknown>(req);
  try {
    const store = getConversationStore(config.dataDir);
    const conversation = await store.upsert(body);
    sendJson(res, 200, { conversation });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: message });
  }
}

async function handleConversationDelete(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RobotConfig,
  id: string,
): Promise<void> {
  const store = getConversationStore(config.dataDir);
  const ok = await store.delete(id);
  if (!ok) {
    sendJson(res, 404, { error: 'Conversation not found' });
    return;
  }
  sendJson(res, 200, { ok: true, id });
}

async function serveStatic(res: http.ServerResponse, staticDir: string, urlPath: string): Promise<boolean> {
  const safe = path.normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(staticDir, safe === '/' ? 'index.html' : safe);
  if (!filePath.startsWith(staticDir)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }

  try {
    let st = await fsPromises.stat(filePath);
    if (st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      st = await fsPromises.stat(filePath);
    }
    if (!st.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    const data = await fsPromises.readFile(filePath);
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
    return true;
  } catch {
    try {
      const index = path.join(staticDir, 'index.html');
      const data = await fsPromises.readFile(index);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
}

export function createApiServer(options: ApiServerOptions = {}): http.Server {
  const config = options.config ?? loadConfig();
  const staticDir = options.staticDir;

  const server = http.createServer(async (req, res) => {
    withCors(res);
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (method === 'GET' && (pathname === '/api/health' || pathname === '/api/doctor')) {
        await handleHealth(req, res, config);
        return;
      }
      if (method === 'GET' && pathname === '/api/skills') {
        await handleSkills(req, res, config);
        return;
      }
      if (method === 'GET' && pathname === '/api/routines') {
        await handleRoutines(req, res, config);
        return;
      }
      if (method === 'POST' && pathname === '/api/chat') {
        await handleChat(req, res, config);
        return;
      }
      if (method === 'POST' && pathname === '/api/chat/stream') {
        await handleChatStream(req, res, config);
        return;
      }
      if (method === 'POST' && pathname.startsWith('/api/approvals/')) {
        const id = decodeURIComponent(pathname.slice('/api/approvals/'.length));
        if (!id) {
          sendJson(res, 400, { error: 'approval id required' });
          return;
        }
        await handleApproval(req, res, id);
        return;
      }
      if (method === 'GET' && pathname === '/api/approvals') {
        sendJson(res, 200, { pending: globalApprovalBroker.list() });
        return;
      }
      if (method === 'GET' && pathname === '/api/conversations') {
        await handleConversationsList(req, res, config);
        return;
      }
      if (method === 'POST' && pathname === '/api/conversations') {
        await handleConversationUpsert(req, res, config);
        return;
      }
      if (
        (method === 'GET' || method === 'DELETE') &&
        pathname.startsWith('/api/conversations/')
      ) {
        const id = decodeURIComponent(pathname.slice('/api/conversations/'.length));
        if (!id || id.includes('/')) {
          sendJson(res, 400, { error: 'conversation id required' });
          return;
        }
        if (method === 'GET') {
          await handleConversationGet(req, res, config, id);
        } else {
          await handleConversationDelete(req, res, config, id);
        }
        return;
      }

      if (staticDir && method === 'GET') {
        const served = await serveStatic(res, staticDir, pathname);
        if (served) return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      } else {
        res.end();
      }
    }
  });

  return server;
}

export function defaultStaticDir(): string {
  return path.join(ROOT, 'gui', 'dist');
}

export function staticDirExists(dir = defaultStaticDir()): boolean {
  try {
    return fs.statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

export async function listenApiServer(
  options: ApiServerOptions = {},
): Promise<{ server: http.Server; port: number; host: string }> {
  const host = options.host ?? process.env.ROBOT_GUI_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.ROBOT_GUI_PORT ?? 8787);
  const staticDir =
    options.staticDir ??
    (process.env.ROBOT_GUI_STATIC
      ? path.resolve(process.env.ROBOT_GUI_STATIC)
      : staticDirExists()
        ? defaultStaticDir()
        : undefined);

  const server = createApiServer({ ...options, staticDir, host, port });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return { server, port, host };
}
