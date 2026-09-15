# Architecture — The Robot

Interview-oriented overview of the scaffold. Implementation today is intentionally thin; boundaries are real so the next layer (MCP servers, Goose-style distro wiring, richer planners) has a clear home.

## Goals

- Run useful agent loops **offline** with a local provider (Ollama by default).
- Package reusable behavior as **skills** (`SKILL.md` packs).
- Automate recurring work with **routines** (cron + simple triggers).
- Call external capabilities through **MCP tool hooks**.
- Require **approval** before destructive actions.
- Present a **branded CLI** (`the-robot` / `robot`) and local **chat GUI** suitable for a personal distro.

## Stack choice

**TypeScript / Node 20+** keeps the portfolio demo portable: fast install, readable modules, easy CLI demos. The layout mirrors concepts found in Goose custom distros (skills, extensions/tools, providers) without forking Rust. A later phase can replace or wrap the runtime while keeping skill and routine formats stable.

## Component map

```
src/
  cli/           Command parsing, banner, help, entrypoint
  server/        Local HTTP API + static GUI hosting
  core/          Runtime loop, skill loader, routine registry
  providers/     Ollama live /api/chat (+ stream) with offline errors
  mcp/           MCP client hooks (connect / list / call stubs)
  approvals/     Destructive-action gate + in-memory GUI broker
gui/             Vite + React chat UI (sidebar, thread, composer)
skills/          Example SKILL.md packs
routines/        Example schedule / trigger configs
```

### GUI + HTTP API

`src/server/api.ts` exposes `/api/health`, `/api/skills`, `/api/routines`, `/api/chat`, SSE `/api/chat/stream`, and `/api/approvals/:id`, calling the same `runSession` used by the CLI. In dev, Vite proxies `/api` to port 8787; in production, the API serves `gui/dist` as static files. The UI streams tokens/steps over SSE, renders markdown, and can be wrapped by the optional Electron shell in `desktop/`.

### CLI

`src/cli/index.ts` is the bin entry. It prints a short Robot banner, dispatches subcommands (`run`, `skills`, `routines`, `doctor`), and supports `--dry-run` so demos work without a live model.

### Runtime loop

`src/core/runtime.ts` owns a minimal session:

1. Load config (env + defaults), including `ROBOT_WORKSPACE` sandbox root.
2. Resolve skills, optional routine context, and normalize conversation `history`.
3. If dry-run: plan steps + built-in tool calls (no side effects), honor approvals, exit.
4. Else: call Ollama `/api/chat` with history **and tool specs**; when the model returns `tool_calls`, execute sandboxed tools (approvals), append `role:tool` results, and loop (up to `maxToolRounds`). If no tool_calls, fall back to the prompt heuristic. MCP remains an extension stub.

### Built-in tools

`src/tools/` implements `list_dir`, `read_file`, `write_file`, and optional `run_command`. All file paths resolve under `workspaceRoot` and reject `..` escapes. Tool schemas (`schema.ts`) are exposed to Ollama; `parseModelToolCalls` turns model responses into runtime calls. `run_command` is argv-only (`execFile`, no shell) and gated by `ROBOT_ENABLE_RUN_COMMAND`. Write/destructive tiers go through the approval gate.

### Conversation store

`src/core/conversations.ts` persists chats as JSON under `ROBOT_DATA_DIR/conversations` (default `~/.the-robot/conversations`). The API exposes CRUD at `/api/conversations`; the GUI prefers the server store and falls back to `localStorage`.

### Skills

Each skill is a directory with `SKILL.md`:

```markdown
---
name: summarize-notes
description: …
triggers: […]
approval: none | read | write | destructive
---

# Instructions
…
```

The loader (`src/core/skills.ts`) parses frontmatter and body. Skills are the portable unit for “how the agent should behave” for a task class.

### Routines

JSON configs under `routines/` describe:

- `schedule` — cron expression, or
- `trigger` — simple event name (`on-start`, `manual`, `file-change`, …)
- `skill` — skill name to bind
- `prompt` — default user prompt / goal

The registry lists and validates; a real scheduler (node-cron or system cron invoking the CLI) is the obvious next step.

### Providers (Ollama)

`src/providers/ollama.ts` centralizes host, model, and a `chat()` stub that can later call `/api/chat`. Offline-first means:

- Default provider is local.
- Dry-run never requires network.
- Doctor command checks Ollama reachability without failing the whole CLI.

### MCP tool hooks

`src/mcp/client.ts` defines the interface the runtime expects: `connect`, `listTools`, `callTool`. Stubs return empty lists / dry-run payloads so wiring a real MCP SDK is localized to this module.

### Approval gates

`src/approvals/gate.ts` classifies actions (`read`, `write`, `destructive`) and applies `ROBOT_APPROVAL_MODE`:

| Mode | Behavior |
| --- | --- |
| `prompt` | Require confirmation for write/destructive (stub logs intent in dry-run) |
| `auto-approve` | Log and allow (dev / trusted env only) |
| `deny` | Block write/destructive |

Skills declare a default approval tier in frontmatter; tools can raise the tier.

## Data flow (run)

```
user prompt
  → CLI flags (--dry-run, --skill, --routine)
  → Runtime loads skills / routine
  → Planner selects skill context
  → Provider generates next step (or dry-run plan)
  → Tool call? → MCP hook → Approval gate → result
  → Loop until done / max steps
```

## Extensibility

| Extension | Where |
| --- | --- |
| New skill pack | `skills/<name>/SKILL.md` |
| New routine | `routines/<name>.json` |
| New provider | `src/providers/<name>.ts` + config switch |
| Real MCP | Implement `McpClient` against an MCP SDK |
| Goose distro bridge | Keep skill/routine formats; swap or embed runtime |

## Non-goals (v0 scaffold)

- Full multi-agent orchestration
- Cloud-only providers as default
- Shipping a compiled Goose binary inside this repo

Those can land later without renaming the product or collapsing module boundaries.
