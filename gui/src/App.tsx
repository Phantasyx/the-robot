import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fetchHealth, fetchRoutines, fetchSkills, postChat } from './api';
import { loadConversations, saveConversations, uid } from './storage';
import type { ChatMessage, Conversation, HealthInfo, RoutineInfo, SkillInfo } from './types';

function titleFromPrompt(prompt: string): string {
  const t = prompt.trim().replace(/\s+/g, ' ');
  return t.length <= 42 ? t || 'New chat' : `${t.slice(0, 41)}…`;
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function createConversation(partial?: Partial<Conversation>): Conversation {
  const now = Date.now();
  return {
    id: uid('conv'),
    title: 'New chat',
    messages: [],
    updatedAt: now,
    dryRun: true,
    ...partial,
  };
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const loaded = loadConversations();
    return loaded.length > 0 ? loaded : [createConversation()];
  });
  const [activeId, setActiveId] = useState(() => conversations[0]?.id ?? '');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [routines, setRoutines] = useState<RoutineInfo[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? conversations[0],
    [conversations, activeId],
  );

  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [h, s, r] = await Promise.all([fetchHealth(), fetchSkills(), fetchRoutines()]);
        if (cancelled) return;
        setHealth(h);
        setSkills(s);
        setRoutines(r);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [active?.messages, sending]);

  const updateActive = useCallback(
    (updater: (c: Conversation) => Conversation) => {
      setConversations((prev) => prev.map((c) => (c.id === active?.id ? updater(c) : c)));
    },
    [active?.id],
  );

  const newChat = () => {
    const c = createConversation({
      dryRun: active?.dryRun ?? true,
      skill: active?.skill,
      routine: active?.routine,
    });
    setConversations((prev) => [c, ...prev]);
    setActiveId(c.id);
    setDraft('');
    textareaRef.current?.focus();
  };

  const send = async () => {
    if (!active || sending) return;
    const prompt = draft.trim();
    if (!prompt && !active.routine) return;

    const userMsg: ChatMessage = {
      id: uid('msg'),
      role: 'user',
      content: prompt || `(routine: ${active.routine})`,
      createdAt: Date.now(),
    };

    updateActive((c) => ({
      ...c,
      title: c.messages.length === 0 ? titleFromPrompt(prompt || c.routine || 'Routine') : c.title,
      messages: [...c.messages, userMsg],
      updatedAt: Date.now(),
    }));
    setDraft('');
    setSending(true);

    try {
      const result = await postChat({
        prompt,
        dryRun: active.dryRun,
        skill: active.skill || undefined,
        routine: active.routine || undefined,
      });

      const providerStep = [...result.steps].reverse().find((s) => s.kind === 'provider');
      const content =
        providerStep?.message ||
        result.summary ||
        (active.dryRun
          ? 'Dry-run finished. Expand activity to inspect planned steps.'
          : 'Session complete.');

      const assistantMsg: ChatMessage = {
        id: uid('msg'),
        role: 'assistant',
        content,
        summary: result.summary,
        steps: result.steps,
        createdAt: Date.now(),
      };

      updateActive((c) => ({
        ...c,
        messages: [...c.messages, assistantMsg],
        updatedAt: Date.now(),
      }));
    } catch (err) {
      const assistantMsg: ChatMessage = {
        id: uid('msg'),
        role: 'assistant',
        content: err instanceof Error ? err.message : String(err),
        error: true,
        createdAt: Date.now(),
      };
      updateActive((c) => ({
        ...c,
        messages: [...c.messages, assistantMsg],
        updatedAt: Date.now(),
      }));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            ⌖
          </div>
          <div className="brand-text">
            <strong>The Robot</strong>
            <span>offline agent runtime</span>
          </div>
        </div>

        <div className="sidebar-actions">
          <button type="button" className="btn btn-block" onClick={newChat}>
            + New chat
          </button>
        </div>

        <div className="sidebar-scroll">
          <div className="section-label">Conversations</div>
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`conv-item${c.id === active?.id ? ' active' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <div className="conv-title">{c.title}</div>
              <div className="conv-meta">{formatTime(c.updatedAt)}</div>
            </button>
          ))}

          <div className="section-label">Skills</div>
          {skills.length === 0 ? (
            <div className="meta-item">
              <div className="desc">{loadError ? 'API offline' : 'No skills loaded'}</div>
            </div>
          ) : (
            skills.map((s) => (
              <button
                key={s.name}
                type="button"
                className={`meta-item${active?.skill === s.name ? ' selected' : ''}`}
                onClick={() =>
                  updateActive((c) => ({
                    ...c,
                    skill: c.skill === s.name ? undefined : s.name,
                    routine: undefined,
                  }))
                }
                title={s.description}
              >
                <div className="name">{s.name}</div>
                <div className="desc">{s.description || s.approval}</div>
              </button>
            ))
          )}

          <div className="section-label">Routines</div>
          {routines.length === 0 ? (
            <div className="meta-item">
              <div className="desc">No routines loaded</div>
            </div>
          ) : (
            routines.map((r) => (
              <button
                key={r.name}
                type="button"
                className={`meta-item${active?.routine === r.name ? ' selected' : ''}`}
                onClick={() =>
                  updateActive((c) => ({
                    ...c,
                    routine: c.routine === r.name ? undefined : r.name,
                    skill: r.skill,
                  }))
                }
                title={r.prompt}
              >
                <div className="name">{r.name}</div>
                <div className="desc">
                  {r.description || (r.schedule ? `cron ${r.schedule}` : r.trigger || r.skill)}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="status-panel">
          <div className="status-row">
            <span>Status</span>
            <span>
              <span className={`status-dot ${health?.ok ? 'ok' : 'bad'}`} />
              {health ? 'API up' : loadError ? 'API down' : '…'}
            </span>
          </div>
          <div className="status-row">
            <span>Provider</span>
            <span>{health?.provider ?? '—'}</span>
          </div>
          <div className="status-row">
            <span>Model</span>
            <span>{health?.model ?? '—'}</span>
          </div>
          <div className="status-row">
            <span>Ollama</span>
            <span>
              <span className={`status-dot ${health?.ollama?.ok ? 'ok' : 'bad'}`} />
              {health?.ollama?.ok ? 'reachable' : 'offline'}
            </span>
          </div>
          <div className="status-row">
            <span>Loaded</span>
            <span>
              {health?.skillsLoaded ?? 0} skills · {health?.routinesLoaded ?? 0} routines
            </span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="main-header">
          <div>
            <h1>{active?.title ?? 'The Robot'}</h1>
            <p>
              {active?.dryRun ? 'Dry-run mode' : 'Live session'}
              {active?.skill ? ` · skill ${active.skill}` : ''}
              {active?.routine ? ` · routine ${active.routine}` : ''}
            </p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (!active) return;
              updateActive((c) => ({
                ...c,
                title: 'New chat',
                messages: [],
                updatedAt: Date.now(),
              }));
            }}
          >
            Clear chat
          </button>
        </header>

        <div className="thread" ref={threadRef}>
          {!active?.messages.length && (
            <div className="empty-state">
              <h2>Ready when you are</h2>
              <p>
                Send a prompt to run a session. Dry-run plans steps without calling tools; turn it
                off to hit the local provider path. Pick a skill or routine from the sidebar to
                steer the runtime.
              </p>
            </div>
          )}

          {active?.messages.map((m) => (
            <div key={m.id} className={`message-row ${m.role}`}>
              <div className={`bubble ${m.role}${m.error ? ' error' : ''}`}>
                <div className="bubble-label">{m.role === 'user' ? 'You' : 'The Robot'}</div>
                <div>{m.content}</div>
                {m.summary && !m.error ? <div className="summary">{m.summary}</div> : null}
                {m.steps && m.steps.length > 0 ? (
                  <details className="activity">
                    <summary>Activity · {m.steps.length} steps</summary>
                    <div className="activity-list">
                      {m.steps.map((s) => (
                        <div key={`${m.id}-${s.index}`} className="step">
                          <span className="idx">{s.index}</span>
                          <span className="kind">{s.kind}</span>
                          <span className="msg">{s.message}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            </div>
          ))}

          {sending ? (
            <div className="message-row assistant">
              <div className="bubble assistant">
                <div className="bubble-label">The Robot</div>
                <div>Working…</div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="composer">
          <div className="composer-toolbar">
            <label className="toggle">
              <input
                type="checkbox"
                checked={active?.dryRun ?? true}
                onChange={(e) => updateActive((c) => ({ ...c, dryRun: e.target.checked }))}
              />
              Dry-run
            </label>

            <label className="field">
              Skill
              <select
                value={active?.skill ?? ''}
                onChange={(e) =>
                  updateActive((c) => ({
                    ...c,
                    skill: e.target.value || undefined,
                  }))
                }
              >
                <option value="">Auto</option>
                {skills.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              Routine
              <select
                value={active?.routine ?? ''}
                onChange={(e) => {
                  const name = e.target.value || undefined;
                  const r = routines.find((x) => x.name === name);
                  updateActive((c) => ({
                    ...c,
                    routine: name,
                    skill: r?.skill ?? c.skill,
                  }));
                }}
              >
                <option value="">None</option>
                {routines.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="composer-row">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message The Robot… (Enter to send, Shift+Enter for newline)"
              disabled={sending}
            />
            <button
              type="button"
              className="btn btn-primary send"
              onClick={() => void send()}
              disabled={sending || (!draft.trim() && !active?.routine)}
            >
              Send
            </button>
          </div>
          <div className="hint">
            Conversations stay in this browser (localStorage). Runtime calls hit the local API —
            no cloud required.
          </div>
        </div>
      </main>
    </div>
  );
}
