#!/usr/bin/env node
import { listenApiServer, staticDirExists, defaultStaticDir } from './api.js';

async function main(): Promise<void> {
  const serveStatic = process.argv.includes('--static') || process.argv.includes('--prod');
  const { host, port } = await listenApiServer({
    staticDir: serveStatic || staticDirExists() ? defaultStaticDir() : undefined,
  });

  const mode = serveStatic || staticDirExists() ? 'API + GUI' : 'API only';
  console.log(`The Robot ${mode} listening on http://${host}:${port}`);
  if (serveStatic && !staticDirExists()) {
    console.log('gui/dist missing. Run `npm run gui:build` first (gui/dist is gitignored), then `npm run start:gui`.');
  } else if (!serveStatic && !staticDirExists()) {
    console.log('Tip: `npm run gui` for Vite + API, or `npm run gui:build` then `npm run start:gui`.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
