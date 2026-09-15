# Architecture — The Robot

Interview-oriented overview of the scaffold. Implementation today is intentionally thin; boundaries are real so the next layer (MCP servers, Goose-style distro wiring, richer planners) has a clear home.

## Goals

- Run useful agent loops **offline** with a local provider (Ollama by default).
- Package reusable behavior as **skills** (`SKILL.md` packs).
- Automate recurring work with **routines** (cron + simple triggers).
- Call external capabilities through **MCP tool hooks**.
- Require **approval** before destructive actions.
- Present a **branded CLI** (`the-robot` / `robot`) suitable for a personal distro.

## Stack choice

**TypeScript / Node 20+** keeps the portfolio demo portable: fast install, readable modules, easy CLI demos. The layout mirrors concepts found in Goose custom distros (skills, extensions/tools, providers) without forking Rust. A later phase can replace or wrap the runtime while keeping skill and routine formats stable.

## Component map

```
src/
  cli/           Command parsing, banner, help, entrypoint
  core/          Runtime loop, skill loader, routine registry
  providers/     Ollama / local provider config and stubs
  mcp/           MCP client hooks (connect / list / call stubs)
  approvals/     Destructive-action gate
skills/          Example SKILL.md packs
routines/        Example schedule / trigger configs
```

### CLI

`src/cli/index.ts` is the bin entry. It prints a short Robot banner, dispatches subcommands (`run`, `skills`, `routines`, `doctor`), and supports `--dry-run` so demos work without a live model.

### Runtime loop

`src/core/runtime.ts` owns a minimal session:

1. Load config (env + defaults).
2. Resolve skills and optional routine context.
3. If dry-run: plan steps, print what would happen, exit.
4. Else: call the provider stub / Ollama client, route tool requests through MCP + approvals.

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

### Providers (offline mode)

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
