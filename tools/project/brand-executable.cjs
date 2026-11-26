'use strict';

const { execFileSync } = require('node:child_process');
const { fs, path, root, isWithin } = require('./common.cjs');

function brandExecutable(executable, icon, version) {
  const target = path.resolve(executable);
  if (![path.join(root, 'out'), path.join(root, '.build')].some(folder => isWithin(folder, target)) || path.extname(target).toLowerCase() !== '.exe') {
    throw new Error('Executable resource editing is restricted to new build or release output.');
  }
  if (!fs.statSync(target).isFile() || !fs.statSync(icon).isFile()) throw new Error('Executable or icon is missing.');
  const editor = path.resolve(path.dirname(require.resolve('rcedit')), '../bin/rcedit-x64.exe');
  // Windows fixed versions use four integers. Keep the full prerelease label in the display strings.
  const [major, minor, patch] = version.split('-')[0].split('.');
  const revision = version.match(/-(?:[\w-]+)\.(\d+)$/)?.[1] || '0';
  const fixed = [major, minor, patch, revision].join('.');
  execFileSync(editor, [target, '--set-icon', path.resolve(icon),
    '--set-file-version', fixed, '--set-product-version', fixed,
    '--set-version-string', 'FileVersion', version, '--set-version-string', 'ProductVersion', version,
    '--set-version-string', 'ProductName', '颜如玉', '--set-version-string', 'FileDescription', '颜如玉阅览室',
  ], { windowsHide: true, stdio: 'pipe' });
}

module.exports = { brandExecutable };
