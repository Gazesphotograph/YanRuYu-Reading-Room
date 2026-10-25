'use strict';

const { fs, path, root, walk, copyFile, npm, uniqueDirectory, writePointer } = require('./common.cjs');

try {
  const baseline = path.join(root, 'source', 'manager-upstream-v1.6.15');
  const folder = uniqueDirectory(path.join(root, '.build'), 'manager-upstream-reference');
  const allowedFiles = ['package.json', 'package-lock.json', 'index.html', 'vite.config.mjs', 'LICENSE'];
  for (const name of allowedFiles) copyFile(path.join(baseline, name), path.join(folder, name));
  for (const tree of ['src', 'public']) {
    for (const file of walk(path.join(baseline, tree))) copyFile(file, path.join(folder, path.relative(baseline, file)));
  }
  // The upstream project imports an untracked GitHub token. Reference builds
  // deliberately supply an empty value; no private file is ever read or copied.
  fs.writeFileSync(path.join(folder, 'secret_key.json'), JSON.stringify({ gh_token: '' }) + '\n');
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], folder);
  npm(['run', 'build'], folder, { env: { ...process.env, ESBUILD_WORKER_THREADS: '0' } });
  writePointer('last-manager-reference.json', { folder, dist: path.join(folder, 'dist'), kind: 'upstream-reference-only' });
  console.log(`Upstream Vue reference built: ${path.join(folder, 'dist')}`);
  console.log('This reference does not contain all local customizations and is never used by the production package command.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
