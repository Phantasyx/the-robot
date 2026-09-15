import type { HealthInfo, RoutineInfo, RunStep, SkillInfo } from './types';

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
