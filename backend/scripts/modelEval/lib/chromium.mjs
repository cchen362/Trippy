// Headless Chromium for the fixture renderers (renderExtractionFixtures.mjs, renderFactsFixtures.mjs).
//
// Uses the Chromium headless shell Playwright already installed, as a child process; no npm
// dependency. Chrome path: args.chrome, else CHROME_PATH, else the newest
// %LOCALAPPDATA%\ms-playwright\chromium_headless_shell-*\chrome-headless-shell-win64 install.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function findChrome(args) {
  const explicit = args.chrome ?? process.env.CHROME_PATH;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Chrome not found at ${explicit}`);
    return explicit;
  }
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (existsSync(root)) {
    const installs = readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const d of installs) {
      const exe = join(root, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error(
    'Chromium headless shell not found. Pass --chrome <path> or set CHROME_PATH; Playwright installs it as ' +
    '%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-<n>\chrome-headless-shell-win64\chrome-headless-shell.exe ' +
    '(npx playwright install chromium).',
  );
}

export function runChrome(chrome, profileDir, flags, htmlPath, outPath) {
  rmSync(outPath, { force: true });
  const result = spawnSync(
    chrome,
    ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileDir}`, ...flags, pathToFileURL(htmlPath).href],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (result.error) throw result.error;
  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    throw new Error(`chrome produced no ${outPath} (exit ${result.status})\n${result.stderr}`);
  }
}
