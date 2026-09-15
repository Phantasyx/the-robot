import type { HealthInfo, RoutineInfo, RunStep, SkillInfo, StreamEvent } from './types';

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return data;
}

export async function fetchHealth(): Promise<HealthInfo> {
  return parseJson(await fetch('/api/health'));
}

export async function fetchSkills(): Promise<SkillInfo[]> {
  const data = await parseJson<{ skills: SkillInfo[] }>(await fetch('/api/skills'));
  return data.skills;
}

export async function fetchRoutines(): Promise<RoutineInfo[]> {
  const data = await parseJson<{ routines: RoutineInfo[] }>(await fetch('/api/routines'));
  return data.routines;
}

export async function postChat(body: {
  prompt: string;
  dryRun: boolean;
  skill?: string;
  routine?: string;
}): Promise<{ summary: string; steps: RunStep[] }> {
  return parseJson(
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function resolveApproval(
  id: string,
  decision: 'approve' | 'deny',
): Promise<void> {
  await parseJson(
    await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    }),
  );
}

/** Consume POST /api/chat/stream as SSE-style `data: {...}` lines. */
export async function streamChat(
  body: {
    prompt: string;
    dryRun: boolean;
    skill?: string;
    routine?: string;
  },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  if (!res.body) {
    throw new Error('No response body for stream');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload) as StreamEvent;
        onEvent(event);
      } catch {
        /* skip malformed */
      }
    }
  }

  if (buffer.trim().startsWith('data:')) {
    const payload = buffer.trim().slice(5).trim();
    if (payload) {
      try {
        onEvent(JSON.parse(payload) as StreamEvent);
      } catch {
        /* ignore */
      }
    }
  }
}
