# Testing The Robot

Checklist for a first local smoke of The Robot (CLI + GUI). `gui/dist` is **gitignored** — always build the GUI before `npm run start:gui`.

## 1. Install

```bash
git clone https://github.com/Phantasyx/the-robot.git
cd the-robot
npm install
cp .env.example .env   # optional
npm test
```

## 2. GUI (dev or built)

**Dev (recommended while iterating):**

```bash
npm run gui
# open http://127.0.0.1:5173
```

**Built static UI + API (one port):**

```bash
npm run gui:build      # required — gui/dist is not committed
npm run start:gui      # http://127.0.0.1:8787
```

Confirm the sidebar status: API connected, Chats = `server store` (when API is up).

## 3. Dry-run multi-turn

1. Leave **Dry-run** on.
2. Send: `Remember that my project is called Orchid`
3. Send: `list the contents of .`
4. Expand activity: prior turns mentioned + a `list_dir` plan (no side effects).
5. Create a second chat, then delete the first with **×** — conversation should disappear from the sidebar and from `~/.the-robot/conversations` (or `ROBOT_DATA_DIR`).

## 4. Live Ollama

Recommended models with tool calling:

```bash
ollama pull llama3.2
# or: ollama pull qwen2.5-coder:7b
```

```bash
# .env or shell
# ROBOT_OLLAMA_HOST=http://127.0.0.1:11434
# ROBOT_MODEL=llama3.2
# ROBOT_WORKSPACE=/path/to/sandbox
npm run robot -- doctor
```

In the GUI: flip to **Live**, ask to list or read a file under the workspace. Tokens should stream; tool rounds show in activity.

## 5. Approvals

With `ROBOT_APPROVAL_MODE=prompt` (default):

1. Live or dry-run a write: e.g. `write a file hello.txt with hi`
2. Approve / Deny in the GUI when prompted.
3. Confirm write only lands under `ROBOT_WORKSPACE` after Approve.

## 6. Workspace tools

| Check | How |
| --- | --- |
| Sandbox | Paths outside `ROBOT_WORKSPACE` are rejected |
| `list_dir` / `read_file` | Dry-run plans; live executes |
| `write_file` | Approval-gated |
| `run_command` | Off unless `ROBOT_ENABLE_RUN_COMMAND=1` (argv-only) |

## 7. Conversation persistence

1. Send a few messages; refresh the page — same chats reload from the server store.
2. Delete a chat with **×** — file removed under `<ROBOT_DATA_DIR>/conversations`.
3. Stop the API and open the Vite app alone — UI falls back to `localStorage` (status shows localStorage).

## CLI quick checks

```bash
npm run robot -- run --dry-run "list the contents of ."
npm run robot -- skills list
npm run robot -- routines list
npm run robot -- doctor
```
