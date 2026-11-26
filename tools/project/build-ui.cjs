'use strict';

const { fs, path, root, runNode } = require('./common.cjs');

const bundleEntry = path.join(root, 'resources', 'app', 'dist', 'app', 'main.js');

// Type-checks src/renderer and emits resources/app/dist/app. Runs before the
// source allow-list and copy steps so the bundle is part of every build.
function buildUi({ typecheck = true } = {}) {
  if (typecheck) runNode(path.join(root, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'), ['--noEmit', '-p', path.join(root, 'tsconfig.json')]);
  runNode(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), ['build', '--config', path.join(root, 'vite.config.mts'), '--logLevel', 'warn']);
  if (!fs.existsSync(bundleEntry)) throw new Error(`UI build did not produce ${path.relative(root, bundleEntry)}`);
  return bundleEntry;
}

if (require.main === module) {
  try { console.log(`UI bundle ready: ${path.relative(root, buildUi())}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildUi, bundleEntry };
