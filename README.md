# The Robot

**The Robot** is a personal, offline-capable agent runtime. It is built as a portfolio and interview scaffold: a branded CLI and desktop-like chat GUI with skills, routines, local model config, MCP tool hooks, and approval gates for destructive actions.

Design ideas and packaging patterns are inspired by [Goose](https://github.com/aaif-goose/goose) (Apache-2.0) custom distros. Goose is upstream inspiration for how an agent runtime can be extended and redistributed — not the product name. This repository is a clean TypeScript scaffold, not a fork.

## Why TypeScript

This initial release uses **TypeScript on Node 20+** so demos stay easy to run, read, and extend in interviews. A future path is wiring Goose-style custom distro / MCP integrations on top of this layout; the module boundaries are shaped for that next step.

## Features (scaffold)

| Area | What you get today |
| --- | --- |
| **Skills** | `SKILL.md` packs under `skills/` with metadata and instructions |
| **Routines** | Cron-style and simple trigger configs under `routines/` |
| **MCP hooks** | Stub client surface ready for Model Context Protocol servers |
| **Providers** | Local / Ollama config first (`ROBOT_PROVIDER=ollama`) |
| **Approvals** | Gate for destructive actions (`prompt` / `auto-approve` / `deny`) |
| **CLI** | Branded `the-robot` / `robot` entry with help and dry-run loop |
| **GUI** | Local chat UI (sidebar + thread + composer) wired to the runtime API |

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
```

Build and use the compiled binaries:

```bash
npm run build
node dist/cli/index.js --help
# after npm link, or via package bin:
# the-robot --help
# robot --help
```

## GUI quickstart

The chat GUI is a local web app (Vite + React) served with a small Node HTTP API. No Electron required for this iteration; structure is ready to wrap later.

```bash
npm install          # also installs gui/ dependencies via postinstall
npm run gui          # API on http://127.0.0.1:8787 + Vite on http://127.0.0.1:5173
```

Open **http://127.0.0.1:5173** in your browser. Conversations persist in `localStorage`. Use the Dry-run toggle for offline planning; turn it off to exercise the live provider path.

Production-style (built static UI + API on one port):

```bash
npm run gui:build
npm run start:gui    # http://127.0.0.1:8787
```

API surface:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Doctor / status |
| `GET` | `/api/skills` | Skill packs |
| `GET` | `/api/routines` | Routines |
| `POST` | `/api/chat` | `{ prompt, dryRun, skill?, routine? }` → `{ summary, steps }` |

## Architecture overview

```
CLI (the-robot / robot)  ─┐
GUI (Vite + React)       ─┼→ HTTP API (node:http)
                          └→ Runtime (session, dry-run loop)
                               → Skills loader (SKILL.md packs)
                               → Routines scheduler (cron + triggers)
                               → Provider (Ollama / local stubs)
                               → MCP tool hooks
                               → Approval gates
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for interview-ready detail.

## Skills and routines

- **Skills** live in `skills/<name>/SKILL.md`. Each pack describes when to use it and what tools or steps it expects.
- **Routines** live in `routines/*.json` (or `.yaml`-friendly JSON). They bind a schedule or trigger to a skill and prompt.

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
| `npm test` | Smoke tests (runtime + API) |
| `npm run typecheck` | `tsc --noEmit` |

## License

Apache-2.0. See [LICENSE](LICENSE).

Upstream inspiration: [Goose](https://github.com/aaif-goose/goose) (Apache-2.0). Credit Goose as inspiration for agent-runtime / custom-distro patterns; this project’s name and branding remain **The Robot**.
