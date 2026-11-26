'use strict';

// Prefer the caller's installed Playwright, then Codex's bundled runtime. No user-specific paths.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
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

const runtime = loadPlaywright();
// Recent browser releases can use a system-wide install while Playwright's
// channel lookup checks only a per-user location. Reuse the installed browser
// for isolated test profiles, without installing or opening a personal profile.
function launchOptions(options = {}) {
  if (options.executablePath || process.platform !== 'win32') return options;
  const channel = options.channel;
  if (channel && !['msedge', 'chrome'].includes(channel)) return options;
  if (!channel && fs.existsSync(runtime.chromium.executablePath())) return options;
  const systemDrive = process.env.SystemDrive || path.parse(os.homedir()).root;
  const programFolders = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles,
    path.join(systemDrive, 'Program Files (x86)'), path.join(systemDrive, 'Program Files'), process.env.LOCALAPPDATA].filter(Boolean);
  const products = channel === 'chrome' ? [['Google', 'Chrome', 'Application', 'chrome.exe']]
    : channel === 'msedge' ? [['Microsoft', 'Edge', 'Application', 'msedge.exe']]
    : [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']];
  for (const product of products) for (const folder of programFolders) {
    const executablePath = path.join(folder, ...product);
    if (fs.existsSync(executablePath)) return { ...options, executablePath };
  }
  return options;
}
const launch = runtime.chromium.launch.bind(runtime.chromium);
runtime.chromium.launch = options => launch(launchOptions(options));
const persistent = runtime.chromium.launchPersistentContext.bind(runtime.chromium);
runtime.chromium.launchPersistentContext = (directory, options) => persistent(directory, launchOptions(options));
module.exports = runtime;
