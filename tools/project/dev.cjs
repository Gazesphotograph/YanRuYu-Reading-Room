'use strict';

const { spawn } = require('node:child_process');
const { path, root, electronExecutable } = require('./common.cjs');
const { build } = require('./build.cjs');

try {
  const result = build();
  const electron = electronExecutable();
  const env = { ...process.env, YANRUYU_DATA_DIR: process.env.YANRUYU_DATA_DIR ?? path.join(root, '.dev-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(`Development data directory: ${env.YANRUYU_DATA_DIR}`);
  const child = spawn(electron, [result.app], { env, cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.once('SIGINT', () => child.kill());
} catch (error) { console.error(error.message); process.exitCode = 1; }
