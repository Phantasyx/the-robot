# Contributing to The Robot

Thanks for taking an interest in the project. This repo is an early scaffold for a personal, offline-capable agent runtime. Small, focused changes are easiest to review.

## Ground rules

- Keep the CLI branded as **The Robot** (`the-robot` / `robot`). Do not rename the product after upstream projects.
- Prefer clear, readable TypeScript. Match existing module boundaries (skills, routines, providers, MCP hooks, approvals).
- Destructive or network-facing behavior should go through the approval gate layer.
- Do not commit secrets, tokens, or local `.robot/` state.

## Setup

```bash
npm install
npm run typecheck
npm test
npm run robot -- --help
```

## Pull requests

1. Open an issue or short note describing the change if it touches architecture.
2. Keep commits focused; use plain, human commit messages.
3. Include a smoke test or extend `tests/` when behavior changes.
4. Update `docs/ARCHITECTURE.md` if you change core flows.

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
