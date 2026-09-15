# The Robot

**The Robot** is a personal, offline-capable agent runtime. It is built as a portfolio and interview scaffold: a branded CLI and desktop-like chat GUI with skills, routines, local model config, MCP tool hooks, and approval gates for destructive actions.

Design ideas and packaging patterns are inspired by [Goose](https://github.com/aaif-goose/goose) (Apache-2.0) custom distros. Goose is upstream inspiration for how an agent runtime can be extended and redistributed — not the product name. This repository is a clean TypeScript scaffold, not a fork.

## Why TypeScript

This initial release uses **TypeScript on Node 20+** so demos stay easy to run, read, and extend in interviews. A future path is wiring Goose-style custom distro / MCP integrations on top of this layout; the module boundaries are shaped for that next step.

## Features

| Area | What you get today |
| --- | --- |
| **Skills** | `SKILL.md` packs under `skills/` with metadata and instructions |
| **Routines** | Cron-style and simple trigger configs under `routines/` |
| **MCP hooks** | Stub client surface ready for Model Context Protocol servers |
| **Providers** | Live Ollama `/api/chat` (sync + stream) with graceful offline errors |
| **Approvals** | Gate for destructive actions (`prompt` / `auto-approve` / `deny`); GUI Approve/Deny |
| **CLI** | Branded `the-robot` / `robot` entry with help and dry-run loop |
| **GUI** | Local chat UI with SSE streaming, markdown replies, connection badges |
| **Desktop** | Optional Electron shell (`npm run desktop` / `npm run app`) |

## Quickstart (Ollama / local)

Prerequisites: Node 20+, and optionally [Ollama](https://ollama.com) for local models.

```bash
git clone https://github.com/Phantasyx/the-robot.git
cd the-robot
npm install
cp .env.example .env   # optional

# Dry-run agent loop (no model required)
npm run robot -- run --dry-run "summarize the skills folder"

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
npm run robot -- run "list available skills"
npm run robot -- doctor   # reports Ollama reachability accurately
```

Build and use the compiled binaries:

```bash
npm run build
node dist/cli/index.js --help
```

## GUI quickstart

The chat GUI is a local web app (Vite + React) served with a small Node HTTP API.

```bash
npm install          # also installs gui/ dependencies via postinstall
npm run gui          # API on http://127.0.0.1:8787 + Vite on http://127.0.0.1:5173
```

Open **http://127.0.0.1:5173** in your browser. Conversations persist in `localStorage`.

- **Dry-run** — fully offline planning; write-tier skills pause for Approve/Deny when `ROBOT_APPROVAL_MODE=prompt`.
- **Live** — streams tokens from local Ollama via `POST /api/chat/stream`. If Ollama is down, the UI shows a clear error (dry-run still works).

Production-style (built static UI + API on one port):

```bash
npm run gui:build
npm run start:gui    # http://127.0.0.1:8787
```

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
| `GET` | `/api/health` | Doctor / status (includes Ollama ping) |
| `GET` | `/api/skills` | Skill packs |
| `GET` | `/api/routines` | Routines |
| `POST` | `/api/chat` | `{ prompt, dryRun, skill?, routine? }` → `{ summary, steps }` |
| `POST` | `/api/chat/stream` | SSE stream: `step` / `token` / `approval_required` / `done` / `error` |
| `POST` | `/api/approvals/:id` | `{ decision: "approve" \| "deny" }` |
| `GET` | `/api/approvals` | Pending approval list |

## Offline behavior

| Mode | Without Ollama | With Ollama |
| --- | --- | --- |
| Dry-run CLI / GUI | Full plan + approvals | Same |
| Live CLI / GUI | Clear error from provider / health | Streams chat from `/api/chat` |
| Doctor / health | `ollama.ok: false` + detail | `ollama.ok: true` + model note |

## Architecture overview

```
CLI (the-robot / robot)  ─┐
GUI (Vite + React)       ─┼→ HTTP API (node:http) ± SSE
Desktop (Electron, opt.) ─┘
                          └→ Runtime (session, dry-run / live loop)
                               → Skills loader (SKILL.md packs)
                               → Routines scheduler (cron + triggers)
                               → Provider (Ollama live + stream)
                               → MCP tool hooks
                               → Approval gates (+ GUI broker)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for interview-ready detail.

## Skills and routines

- **Skills** live in `skills/<name>/SKILL.md`. Each pack describes when to use it and what tools or steps it expects.
- **Routines** live in `routines/*.json`. They bind a schedule or trigger to a skill and prompt.

Examples ship in-tree: `skills/summarize-notes`, `skills/local-file-ops`, and routines for a daily summary and a file-watch style trigger.

## Extending and branding

1. Add a skill pack under `skills/` and reload via `robot skills list`.
2. Add a routine under `routines/` and inspect with `robot routines list`.
3. Point MCP at real servers when you wire the client (see `src/mcp/`).
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
| `npm test` | Smoke tests (runtime + API + stream) |
| `npm run typecheck` | `tsc --noEmit` |

## License

Apache-2.0. See [LICENSE](LICENSE).

Upstream inspiration: [Goose](https://github.com/aaif-goose/goose) (Apache-2.0). Credit Goose as inspiration for agent-runtime / custom-distro patterns; this project’s name and branding remain **The Robot**.
