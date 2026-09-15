# Desktop shell (optional)

The Robot GUI is a local web app. This folder is a thin **Electron** wrapper so it feels like a desktop app.

## Requirements

1. Built GUI + API listening (default `http://127.0.0.1:8787`)
2. `electron` installed (devDependency on the repo root)

```bash
# from repo root
npm run gui:build
npm run start:gui          # terminal 1
npm run desktop            # terminal 2 — opens Electron → local GUI
```

Or one-shot (starts API then Electron):

```bash
npm run app
```

If Electron fails to install on your platform, use the browser GUI instead:

```bash
npm run gui                # http://127.0.0.1:5173
# or
npm run start:gui          # http://127.0.0.1:8787
```

Override the URL:

```bash
ROBOT_DESKTOP_URL=http://127.0.0.1:5173 npm run desktop
```
