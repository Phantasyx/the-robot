import {
  deleteConversation as apiDelete,
  fetchAllConversations,
  upsertConversation,
} from './api';
import type { Conversation } from './types';

const KEY = 'the-robot.conversations.v1';

export function loadConversationsLocal(): Conversation[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversationsLocal(conversations: Conversation[]): void {
  localStorage.setItem(KEY, JSON.stringify(conversations));
}

/** @deprecated use loadConversationsLocal — kept for older imports */
export function loadConversations(): Conversation[] {
  return loadConversationsLocal();
}

/** @deprecated use saveConversationsLocal */
export function saveConversations(conversations: Conversation[]): void {
  saveConversationsLocal(conversations);
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export type StoreSource = 'server' | 'local';

/**
 * Prefer server JSON store when the API is reachable; fall back to localStorage.
 * Seeds the server from local when the server is empty.
 */
export async function loadConversationsHybrid(): Promise<{
  conversations: Conversation[];
  source: StoreSource;
}> {
  try {
    const remote = await fetchAllConversations();
    if (remote.length > 0) {
      saveConversationsLocal(remote);
      return { conversations: remote, source: 'server' };
    }
    const local = loadConversationsLocal();
    if (local.length > 0) {
      await Promise.all(local.map((c) => upsertConversation(c).catch(() => null)));
      return { conversations: local, source: 'server' };
    }
    return { conversations: [], source: 'server' };
  } catch {
    return { conversations: loadConversationsLocal(), source: 'local' };
  }
}

/** Persist to localStorage always; mirror to server when `server` is true. */
export async function persistConversations(
  conversations: Conversation[],
  opts: { server: boolean; previousIds?: Set<string> },
): Promise<void> {
  saveConversationsLocal(conversations);
  if (!opts.server) return;

  const currentIds = new Set(conversations.map((c) => c.id));
  try {
    await Promise.all(conversations.map((c) => upsertConversation(c)));
    if (opts.previousIds) {
      for (const id of opts.previousIds) {
        if (!currentIds.has(id)) {
          await apiDelete(id).catch(() => null);
        }
      }
    }
  } catch {
    /* keep local copy; server may be briefly unavailable */
  }
}
