'use strict';

const { execFileSync } = require('node:child_process');
const { fs, path, root, isWithin } = require('./common.cjs');

function brandExecutable(executable, icon) {
  const target = path.resolve(executable);
  if (![path.join(root, 'out'), path.join(root, '.build')].some(folder => isWithin(folder, target)) || path.extname(target).toLowerCase() !== '.exe') {
    throw new Error('Executable resource editing is restricted to new build or release output.');
  }
  if (!fs.statSync(target).isFile() || !fs.statSync(icon).isFile()) throw new Error('Executable or icon is missing.');
  const editor = path.resolve(path.dirname(require.resolve('rcedit')), '../bin/rcedit-x64.exe');
  execFileSync(editor, [target, '--set-icon', path.resolve(icon)], { windowsHide: true, stdio: 'pipe' });
}

module.exports = { brandExecutable };
