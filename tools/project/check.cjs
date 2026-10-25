'use strict';

const { fs, path, root, listSourceFiles, runNode, walk } = require('./common.cjs');
const { spawnSync } = require('node:child_process');

try {
  const sources = listSourceFiles();
  const tooling = walk(path.join(root, 'tools'), { skipDirectories: new Set(['.artifacts', 'node_modules']) });
  const javascript = [...sources, ...tooling].filter(file => /\.(?:js|cjs|mjs)$/.test(file));
  for (const file of javascript) {
    // Node's file-mode syntax detection can fall back to CommonJS after a
    // malformed ESM parse. Chromium loads every dist JS module as ESM, so
    // explicitly check that grammar (including the classic entry IIFE).
    const rendererModule = file.startsWith(path.join(root, 'resources', 'app', 'dist') + path.sep);
    const result = spawnSync(process.execPath, rendererModule ? ['--input-type=module', '--check'] : ['--check', file], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      ...(rendererModule ? { input: fs.readFileSync(file, 'utf8') } : {}),
    });
    if (result.status !== 0) throw new Error(`${path.relative(root, file)}\n${result.stderr || result.error}`);
  }
  for (const file of ['package.json', 'package-lock.json', 'resources/app/package.json', 'resources/app/package-lock.json']) {
    JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  console.log(`Syntax and source allow-list passed: ${javascript.length} JavaScript files, ${sources.length} release source files.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
