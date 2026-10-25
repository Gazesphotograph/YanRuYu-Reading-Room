'use strict';

// Prefer the caller's installed Playwright, then Codex's bundled runtime. No user-specific paths.
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');

function loadPlaywright() {
  const fromWorkspace = createRequire(path.join(process.cwd(), 'package.json'));
  const configured = [process.env.CODEX_PLAYWRIGHT_PATH, process.env.PLAYWRIGHT_MODULE_PATH].filter(Boolean);
  const runtimeHomes = [process.env.USERPROFILE, os.homedir()].filter(Boolean);
  const candidates = [...configured, 'playwright', 'playwright-core'];
  for (const home of new Set(runtimeHomes)) {
    candidates.push(path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'));
  }
  for (const entry of (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, 'playwright'));
  }
  const failures = [];
  for (const candidate of [...new Set(candidates)]) {
    let resolved;
    try { resolved = fromWorkspace.resolve(candidate); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      failures.push(candidate);
      continue;
    }
    return fromWorkspace(resolved);
  }
  throw new Error('Playwright was not found. Install it locally or set CODEX_PLAYWRIGHT_PATH to its module directory. Checked: ' + failures.join(', '));
}

module.exports = loadPlaywright();
