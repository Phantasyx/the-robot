import fs from 'node:fs/promises';
import path from 'node:path';

export interface RoutineConfig {
  name: string;
  description?: string;
  schedule?: string;
  trigger?: string;
  skill: string;
  prompt: string;
  enabled?: boolean;
}

export async function loadRoutines(routinesDir: string): Promise<RoutineConfig[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(routinesDir);
  } catch {
    return [];
  }

  const routines: RoutineConfig[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(routinesDir, file);
    try {
      const raw = await fs.readFile(full, 'utf8');
      const data = JSON.parse(raw) as Partial<RoutineConfig>;
      if (!data.skill || !data.prompt) continue;
      routines.push({
        name: data.name ?? path.basename(file, '.json'),
        description: data.description,
        schedule: data.schedule,
        trigger: data.trigger,
        skill: data.skill,
        prompt: data.prompt,
        enabled: data.enabled !== false,
      });
    } catch {
      // skip invalid
    }
  }
  return routines.sort((a, b) => a.name.localeCompare(b.name));
}

export function findRoutine(routines: RoutineConfig[], name: string): RoutineConfig | undefined {
  return routines.find((r) => r.name === name);
}
