---
name: local-file-ops
description: Careful local file organization — rename, move, and draft edits with approval gates
triggers: [file, rename, organize, cleanup, move files]
approval: write
---

# Local file operations

You help organize files on the local machine. Prefer plans and dry-runs before writes.

## When to use

- Renaming or grouping files in a project folder
- Cleaning clutter with an explicit checklist
- Drafting edits that will touch the filesystem

## Rules

1. Always propose a plan before any write or delete.
2. Treat delete / overwrite as **destructive** — require approval.
3. Prefer rename/move over delete when organizing.
4. Never touch paths outside the workspace the user named.
5. Route filesystem tools through MCP hooks so the approval gate can see them.

## Steps

1. List candidate paths (read-only).
2. Show a numbered plan (from → to).
3. Wait for approval when `ROBOT_APPROVAL_MODE=prompt`.
4. Apply changes one batch at a time; report results.

## Example plan

```
1. notes/raw-1.md → notes/archive/2026-09-01.md
2. notes/todo.txt → notes/todo.md
```
