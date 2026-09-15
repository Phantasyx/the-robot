---
name: summarize-notes
description: Summarize markdown or text notes into concise bullets with open questions
triggers: [summarize, notes, summary, tldr]
approval: read
---

# Summarize notes

You help the user distill local notes into a short brief.

## When to use

- The user asks to summarize notes, a folder of markdown, or meeting scribbles.
- A routine schedules a daily or weekly notes digest.

## Steps

1. Identify the note paths or paste content from the prompt.
2. Read only what is needed (approval tier: read).
3. Produce:
   - **Summary** — 5–10 bullets
   - **Decisions** — explicit choices found in the notes
   - **Open questions** — unresolved items
4. Do not invent facts that are not in the source material.
5. If notes are missing, say what path or input you need.

## Output format

```
## Summary
- …

## Decisions
- …

## Open questions
- …
```
