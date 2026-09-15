import fs from 'node:fs/promises';
import path from 'node:path';

export type ApprovalTier = 'none' | 'read' | 'write' | 'destructive';

export interface SkillMeta {
  name: string;
  description: string;
  triggers: string[];
  approval: ApprovalTier;
}

export interface SkillPack {
  dir: string;
  meta: SkillMeta;
  body: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const trimmed = raw.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) {
    return { meta: {}, body: trimmed };
  }
  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) {
    return { meta: {}, body: trimmed };
  }
  const block = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).replace(/^\s*\n/, '');
  const meta: Record<string, unknown> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value: unknown = m[2].trim();
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    meta[key] = value;
  }
  return { meta, body };
}

function asTier(v: unknown): ApprovalTier {
  if (v === 'none' || v === 'read' || v === 'write' || v === 'destructive') return v;
  return 'read';
}

export async function loadSkills(skillsDir: string): Promise<SkillPack[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(skillsDir);
  } catch {
    return [];
  }

  const packs: SkillPack[] = [];
  for (const name of entries) {
    const dir = path.join(skillsDir, name);
    const skillPath = path.join(dir, 'SKILL.md');
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) continue;
      const raw = await fs.readFile(skillPath, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const skillName = String(meta.name ?? name);
      packs.push({
        dir,
        meta: {
          name: skillName,
          description: String(meta.description ?? ''),
          triggers: Array.isArray(meta.triggers)
            ? meta.triggers.map(String)
            : typeof meta.triggers === 'string'
              ? [meta.triggers]
              : [],
          approval: asTier(meta.approval),
        },
        body,
      });
    } catch {
      // skip incomplete packs
    }
  }
  return packs.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
}

export function findSkill(packs: SkillPack[], name: string): SkillPack | undefined {
  return packs.find((p) => p.meta.name === name);
}
