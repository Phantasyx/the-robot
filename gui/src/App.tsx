import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fetchHealth, fetchRoutines, fetchSkills, resolveApproval, streamChat } from './api';
import { Markdown } from './Markdown';
import { loadConversations, saveConversations, uid } from './storage';
import type {
  ChatMessage,
  Conversation,
  HealthInfo,
  PendingApproval,
  RoutineInfo,
  RunStep,
  SkillInfo,
  StreamEvent,
} from './types';

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
  const [approving, setApproving] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? conversations[0],
    [conversations, activeId],
  );

  const pendingApproval = useMemo(() => {
    const msgs = active?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].pendingApproval) return msgs[i].pendingApproval!;
    }
    return null as PendingApproval | null;
  }, [active?.messages]);

  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  const refreshHealth = useCallback(async () => {
    try {
      const [h, s, r] = await Promise.all([fetchHealth(), fetchSkills(), fetchRoutines()]);
      setHealth(h);
      setSkills(s);
      setRoutines(r);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const t = setInterval(() => void refreshHealth(), 8000);
    return () => clearInterval(t);
  }, [refreshHealth]);

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

  const patchAssistant = useCallback(
    (assistantId: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => ChatMessage)) => {
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== active?.id) return c;
          return {
            ...c,
            updatedAt: Date.now(),
            messages: c.messages.map((m) => {
              if (m.id !== assistantId) return m;
              return typeof patch === 'function' ? patch(m) : { ...m, ...patch };
            }),
          };
        }),
      );
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

    const assistantId = uid('msg');
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      steps: [],
      streaming: true,
      createdAt: Date.now(),
    };

    updateActive((c) => ({
      ...c,
      title: c.messages.length === 0 ? titleFromPrompt(prompt || c.routine || 'Routine') : c.title,
      messages: [...c.messages, userMsg, assistantMsg],
      updatedAt: Date.now(),
    }));
    setDraft('');
    setSending(true);

    const ac = new AbortController();
    abortRef.current = ac;

    let tokenBuf = '';
    let steps: RunStep[] = [];
    let sawDone = false;
    let sawError = false;

    try {
      await streamChat(
        {
          prompt,
          dryRun: active.dryRun,
          skill: active.skill || undefined,
          routine: active.routine || undefined,
        },
        (event: StreamEvent) => {
          if (event.type === 'token') {
            tokenBuf += event.text;
            patchAssistant(assistantId, {
              content: tokenBuf,
              streaming: true,
              steps: [...steps],
            });
            return;
          }
          if (event.type === 'step') {
            steps = [...steps, event.step];
            // Prefer streamed tokens for main content; otherwise surface latest provider/plan text
            const provider = [...steps].reverse().find((s) => s.kind === 'provider');
            patchAssistant(assistantId, {
              content: tokenBuf || provider?.message || '',
              steps: [...steps],
              streaming: true,
            });
            return;
          }
          if (event.type === 'approval_required') {
            patchAssistant(assistantId, {
              pendingApproval: {
                id: event.id,
                action: event.action,
                tier: event.tier,
                detail: event.detail,
              },
              steps: [...steps],
              streaming: true,
            });
            return;
          }
          if (event.type === 'done') {
            sawDone = true;
            steps = event.steps;
            const providerStep = [...event.steps].reverse().find((s) => s.kind === 'provider');
            const content =
              tokenBuf ||
              providerStep?.message ||
              event.summary ||
              (active.dryRun
                ? 'Dry-run finished. Expand activity to inspect planned steps.'
                : 'Session complete.');
            patchAssistant(assistantId, {
              content,
              summary: event.summary,
              steps: event.steps,
              streaming: false,
              pendingApproval: undefined,
            });
            return;
          }
          if (event.type === 'error') {
            sawError = true;
            patchAssistant(assistantId, {
              content: event.message || 'Request failed',
              error: true,
              streaming: false,
              pendingApproval: undefined,
              steps: [...steps],
            });
          }
        },
        ac.signal,
      );

      if (!sawDone && !sawError) {
        const providerStep = [...steps].reverse().find((s) => s.kind === 'provider');
        patchAssistant(assistantId, {
          content:
            tokenBuf ||
            providerStep?.message ||
            (active.dryRun ? 'Dry-run finished.' : 'Session complete.'),
          steps,
          streaming: false,
          pendingApproval: undefined,
        });
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        patchAssistant(assistantId, {
          content: tokenBuf || 'Cancelled.',
          streaming: false,
          pendingApproval: undefined,
        });
      } else {
        patchAssistant(assistantId, {
          content: err instanceof Error ? err.message : String(err),
          error: true,
          streaming: false,
          pendingApproval: undefined,
          steps,
        });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      void refreshHealth();
    }
  };

  const onApprove = async (decision: 'approve' | 'deny') => {
    if (!pendingApproval || approving) return;
    setApproving(true);
    try {
      await resolveApproval(pendingApproval.id, decision);
      // Clear pending badge; stream will continue with approval step
      if (active) {
        const last = [...active.messages].reverse().find((m) => m.pendingApproval?.id === pendingApproval.id);
        if (last) {
          patchAssistant(last.id, { pendingApproval: undefined });
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setApproving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const apiUp = Boolean(health?.ok) && !loadError;
  const ollamaUp = Boolean(health?.ollama?.ok);
  const modeLive = !(active?.dryRun ?? true);

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
          {conversations.length === 0 ? (
            <div className="meta-item">
              <div className="desc">No conversations yet</div>
            </div>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`conv-item${c.id === active?.id ? ' active' : ''}`}
                onClick={() => setActiveId(c.id)}
              >
                <div className="conv-title">{c.title}</div>
                <div className="conv-meta">
                  {c.dryRun ? 'Dry-run' : 'Live'} · {formatTime(c.updatedAt)}
                </div>
              </button>
            ))
          )}

          <div className="section-label">Skills</div>
          {skills.length === 0 ? (
            <div className="meta-item">
              <div className="desc">{loadError ? 'API offline — start with npm run gui' : 'No skills loaded'}</div>
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
                <div className="desc">
                  {s.description || s.approval} · {s.approval}
                </div>
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
            <span>API</span>
            <span>
              <span className={`status-dot ${apiUp ? 'ok' : 'bad'}`} />
              {apiUp ? 'connected' : loadError ? 'offline' : '…'}
            </span>
          </div>
          <div className="status-row">
            <span>Ollama</span>
            <span title={health?.ollama?.detail}>
              <span className={`status-dot ${ollamaUp ? 'ok' : 'bad'}`} />
              {ollamaUp ? 'reachable' : 'offline'}
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
            <span>Approvals</span>
            <span>{health?.approvalMode ?? '—'}</span>
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
              {active?.skill ? `skill ${active.skill}` : 'auto skill'}
              {active?.routine ? ` · routine ${active.routine}` : ''}
              {!apiUp ? ' · API disconnected' : ''}
              {modeLive && !ollamaUp ? ' · Ollama offline (live will fail)' : ''}
            </p>
          </div>
          <div className="header-actions">
            <span className={`mode-badge ${modeLive ? 'live' : 'dry'}`} title={modeLive ? 'Calls local Ollama' : 'Plans only — no model or tool side effects'}>
              {modeLive ? 'Live' : 'Dry-run'}
            </span>
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
          </div>
        </header>

        <div className="thread" ref={threadRef}>
          {!active?.messages.length && (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden>
                ⌖
              </div>
              <h2>Ready when you are</h2>
              <p>
                Dry-run plans steps offline without calling Ollama. Flip to <strong>Live</strong> when
                Ollama is running to stream a real reply. Pick a skill or routine from the sidebar —
                write-tier skills pause for Approve / Deny when approval mode is <code>prompt</code>.
              </p>
              <div className="empty-tips">
                <button type="button" className="chip" onClick={() => setDraft('summarize notes in ./notes')}>
                  Summarize notes
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    updateActive((c) => ({ ...c, skill: 'local-file-ops', routine: undefined }));
                    setDraft('Propose a safe cleanup plan for tmp/ clutter');
                  }}
                >
                  File cleanup plan
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    const r = routines.find((x) => x.name === 'daily-notes-digest');
                    if (r) updateActive((c) => ({ ...c, routine: r.name, skill: r.skill }));
                  }}
                >
                  Run daily digest routine
                </button>
              </div>
            </div>
          )}

          {active?.messages.map((m) => (
            <div key={m.id} className={`message-row ${m.role}`}>
              <div className={`bubble ${m.role}${m.error ? ' error' : ''}${m.streaming ? ' streaming' : ''}`}>
                <div className="bubble-label">{m.role === 'user' ? 'You' : 'The Robot'}</div>
                {m.role === 'assistant' && !m.error ? (
                  m.content ? (
                    <Markdown text={m.content} />
                  ) : m.streaming ? (
                    <div className="typing">Working…</div>
                  ) : (
                    <div className="typing">No content</div>
                  )
                ) : (
                  <div className="plain">{m.content}</div>
                )}
                {m.pendingApproval ? (
                  <div className="approval-card">
                    <div className="approval-title">Approval required</div>
                    <div className="approval-body">
                      <div>
                        <strong>{m.pendingApproval.action}</strong>
                        <span className="tier"> · {m.pendingApproval.tier}</span>
                      </div>
                      {m.pendingApproval.detail ? <div className="detail">{m.pendingApproval.detail}</div> : null}
                    </div>
                    <div className="approval-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={approving}
                        onClick={() => void onApprove('approve')}
                      >
                        Approve
                      </button>
                      <button type="button" className="btn" disabled={approving} onClick={() => void onApprove('deny')}>
                        Deny
                      </button>
                    </div>
                  </div>
                ) : null}
                {m.summary && !m.error ? <div className="summary">{m.summary}</div> : null}
                {m.steps && m.steps.length > 0 ? (
                  <details className="activity" open={Boolean(m.streaming && !m.content)}>
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
        </div>

        <div className="composer">
          <div className="composer-toolbar">
            <label className={`toggle ${modeLive ? 'live' : 'dry'}`}>
              <input
                type="checkbox"
                checked={active?.dryRun ?? true}
                onChange={(e) => updateActive((c) => ({ ...c, dryRun: e.target.checked }))}
              />
              {active?.dryRun ? 'Dry-run' : 'Live mode'}
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
              disabled={sending || Boolean(pendingApproval)}
            />
            <button
              type="button"
              className="btn btn-primary send"
              onClick={() => void send()}
              disabled={sending || Boolean(pendingApproval) || (!draft.trim() && !active?.routine)}
            >
              {sending ? '…' : 'Send'}
            </button>
          </div>
          <div className="hint">
            {apiUp
              ? modeLive
                ? ollamaUp
                  ? 'Live streaming via local Ollama. Conversations stay in this browser.'
                  : 'Live mode needs Ollama — doctor shows it offline. Dry-run still works fully offline.'
                : 'Dry-run is fully offline. Conversations stay in this browser (localStorage).'
              : 'Start the API with npm run gui or npm run start:gui.'}
          </div>
        </div>
      </main>
    </div>
  );
}
