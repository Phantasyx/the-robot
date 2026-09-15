# The Robot

**The Robot** is a personal, offline-capable agent runtime. It is built as a portfolio and interview scaffold: a branded CLI and desktop-like chat GUI with skills, routines, local model config, built-in sandboxed tools, MCP tool hooks, and approval gates for destructive actions.

Design ideas and packaging patterns are inspired by [Goose](https://github.com/aaif-goose/goose) (Apache-2.0) custom distros. Goose is upstream inspiration for how an agent runtime can be extended and redistributed — not the product name. This repository is a clean TypeScript scaffold, not a fork.

## Why TypeScript

This initial release uses **TypeScript on Node 20+** so demos stay easy to run, read, and extend in interviews. A future path is wiring Goose-style custom distro / MCP integrations on top of this layout; the module boundaries are shaped for that next step.

## Features

| Area | What you get today |
| --- | --- |
| **Multi-turn chat** | GUI + API send conversation history to Ollama; dry-run acknowledges prior turns |
| **Built-in tools** | `list_dir`, `read_file`, `write_file` sandboxed to `ROBOT_WORKSPACE`; optional argv-only `run_command` |
| **Skills** | `SKILL.md` packs under `skills/` with metadata and instructions |
| **Routines** | Cron-style and simple trigger configs under `routines/` |
| **MCP hooks** | Stub client surface ready for Model Context Protocol servers |
| **Providers** | Live Ollama `/api/chat` with **tool calling**, sync/stream, graceful offline errors |
| **Approvals** | Gate for write/destructive tools (`prompt` / `auto-approve` / `deny`); GUI Approve/Deny |
| **CLI** | Branded `the-robot` / `robot` entry with help and dry-run loop |
| **GUI** | Local chat UI with SSE streaming, tool activity, markdown replies, server conversation store |
| **Desktop** | Optional Electron shell (`npm run desktop` / `npm run app`) |

## Quickstart (Ollama / local)

Prerequisites: Node 20+, and optionally [Ollama](https://ollama.com) for local models.

```bash
git clone https://github.com/Phantasyx/the-robot.git
cd the-robot
npm install
cp .env.example .env   # optional

# Dry-run agent loop (no model required)
npm run robot -- run --dry-run "list the contents of ."

# Help
npm run robot -- --help

# Smoke tests
npm test
```

With Ollama running locally:

```bash
ollama pull llama3.2
# ROBOT_OLLAMA_HOST=http://127.0.0.1:11434
# ROBOT_MODEL=llama3.2
# ROBOT_WORKSPACE=/path/to/sandbox   # file tools stay inside this root
npm run robot -- run "list available skills"
npm run robot -- doctor   # reports Ollama + workspace
```

Build and use the compiled binaries:

```bash
npm run build
node dist/cli/index.js --help
```

## Multi-turn + tools

**History** — The GUI sends prior user/assistant turns with each `/api/chat` and `/api/chat/stream` request. Dry-run prints a conversation-context step; live mode includes history in the Ollama message list.

**Agent loop (live)** — Built-in tools are exposed as Ollama/OpenAI-compatible `tools`. When the model returns `tool_calls`, The Robot executes them (sandboxed + approval broker), feeds `role: tool` results back, and continues until a final answer or `ROBOT_MAX_TOOL_ROUNDS`. If the model returns no tool calls (or dry-run), a **prompt-heuristic** planner is the fallback.

**Built-in tools**:

| Tool | Tier | Notes |
| --- | --- | --- |
| `list_dir` | read | Lists a directory under `ROBOT_WORKSPACE` |
| `read_file` | read | Reads a UTF-8 file under the workspace |
| `write_file` | write | Creates/overwrites a file (approval-gated) |
| `run_command` | destructive | **Off by default.** Set `ROBOT_ENABLE_RUN_COMMAND=1`. **Argv-only** via `execFile` (no shell). Prefer `argv: ["cmd","arg"]`; a `command` string is split lightly and **rejects shell metacharacters**. Hard timeout: `ROBOT_RUN_COMMAND_TIMEOUT_MS` (default 15000). |

Dry-run **plans** tool calls (no side effects). Live mode prefers model tool-calling, then heuristic fallback. Paths cannot escape the workspace root.

**Conversations** — Server JSON store under `ROBOT_DATA_DIR/conversations` (default `~/.the-robot/conversations`). GUI prefers the server store when the API is up; falls back to `localStorage`.

Try in the GUI (dry-run first):

1. Send `Remember that my project is called Orchid`
2. Send `list the contents of .` — activity should mention prior turns + a `list_dir` plan
3. Flip to Live (with a tool-capable Ollama model) and Approve any write-tier tool prompts

## GUI quickstart

The chat GUI is a local web app (Vite + React) served with a small Node HTTP API.

```bash
npm install          # also installs gui/ dependencies via postinstall
npm run gui          # API on http://127.0.0.1:8787 + Vite on http://127.0.0.1:5173
```

Open **http://127.0.0.1:5173** in your browser. Conversations prefer the server store (`~/.the-robot/conversations`), with `localStorage` fallback.

- **Dry-run** — fully offline planning; write-tier tools pause for Approve/Deny when `ROBOT_APPROVAL_MODE=prompt`.
- **Live** — streams tokens from local Ollama via `POST /api/chat/stream`, then runs sandboxed tools. If Ollama is down, the UI shows a clear error (dry-run still works).

Production-style (built static UI + API on one port):

`gui/dist` is **gitignored**. Always build before `start:gui` (or after GUI source changes):

```bash
npm run gui:build    # writes gui/dist — required, not committed
npm run start:gui    # http://127.0.0.1:8787
```

See [TESTING.md](TESTING.md) for a full install → dry-run → live Ollama → approvals checklist.

### Desktop window (optional)

```bash
npm install --save-dev electron   # once, if you want the shell
npm run gui:build
npm run app                       # starts API+GUI then opens Electron
# or: npm run start:gui  &&  npm run desktop
```

If Electron is awkward on your machine, skip it — the web GUI is the primary surface. See [desktop/README.md](desktop/README.md).

### API surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Doctor / status (Ollama ping, workspace) |
| `GET` | `/api/skills` | Skill packs |
| `GET` | `/api/routines` | Routines |
| `POST` | `/api/chat` | `{ prompt, dryRun, history?, skill?, routine? }` → `{ summary, steps }` |
| `POST` | `/api/chat/stream` | SSE: `step` / `token` / `approval_required` / `done` / `error` |
| `POST` | `/api/approvals/:id` | `{ decision: "approve" \| "deny" }` |
| `GET` | `/api/approvals` | Pending approval list |
| `GET` | `/api/conversations` | List conversation summaries |
| `GET` | `/api/conversations/:id` | Full conversation JSON |
| `POST` | `/api/conversations` | Upsert conversation body |
| `DELETE` | `/api/conversations/:id` | Delete conversation |

## Offline behavior

| Mode | Without Ollama | With Ollama |
| --- | --- | --- |
| Dry-run CLI / GUI | Full plan + tool plans + approvals | Same |
| Live CLI / GUI | Clear error from provider / health | Streams chat, then executes tools |
| Doctor / health | `ollama.ok: false` + detail | `ollama.ok: true` + model note |

## Architecture overview

```
CLI (the-robot / robot)  ─┐
GUI (Vite + React)       ─┼→ HTTP API (node:http) ± SSE
Desktop (Electron, opt.) ─┘
                          └→ Runtime (history, dry-run / live agent loop)
                               → Skills loader (SKILL.md packs)
                               → Routines scheduler (cron + triggers)
                               → Provider (Ollama tools + stream)
                               → Built-in tools (sandboxed) + MCP hooks
                               → Approval gates (+ GUI broker)
                               → Conversation JSON store (ROBOT_DATA_DIR)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for interview-ready detail.

## Skills and routines

- **Skills** live in `skills/<name>/SKILL.md`. Each pack describes when to use it and what tools or steps it expects.
- **Routines** live in `routines/*.json`. They bind a schedule or trigger to a skill and prompt.

Examples ship in-tree: `skills/summarize-notes`, `skills/local-file-ops`, and routines for a daily summary and a file-watch style trigger.

## Extending and branding

1. Add a skill pack under `skills/` and reload via `robot skills list`.
2. Add a routine under `routines/` and inspect with `robot routines list`.
3. Extend built-in tools under `src/tools/` or point MCP at real servers (`src/mcp/`).
4. Keep CLI banners and bin names as **The Robot** when redistributing a personal distro.
5. Swap provider modules under `src/providers/` for other local backends.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run robot -- …` | Dev CLI via `tsx` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled CLI |
| `npm run gui` | Dev GUI: API + Vite |
| `npm run gui:build` | Build GUI static assets |
| `npm run start:gui` | Serve built GUI + API |
| `npm run desktop` | Electron shell (requires `electron`) |
| `npm run app` | Start API+GUI then Electron |
| `npm test` | Smoke + tool-call parsing + conversation store |
| `npm run typecheck` | `tsc --noEmit` |

## License

Apache-2.0. See [LICENSE](LICENSE).

Upstream inspiration: [Goose](https://github.com/aaif-goose/goose) (Apache-2.0). Credit Goose as inspiration for agent-runtime / custom-distro patterns; this project’s name and branding remain **The Robot**.
