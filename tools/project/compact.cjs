'use strict';

const { spawnSync } = require('node:child_process');
const { fs, path, root, isWithin } = require('./common.cjs');

function compactRuntime(folder, { measureOnly = false, executableOnly = false } = {}) {
  if (process.platform !== 'win32') return { supported: false, reason: 'Transparent executable compression requires Windows and an NTFS volume.' };
  const script = path.join(__dirname, 'compact-runtime.ps1');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', path.resolve(folder)];
  if (measureOnly) args.push('-MeasureOnly');
  if (executableOnly) args.push('-ExecutableOnly');
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Runtime compression failed.');
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

if (require.main === module) {
  try {
    const current = process.argv.includes('--current');
    const directory = process.argv.find(argument => argument.startsWith('--directory='))?.slice('--directory='.length);
    const folder = directory || (current ? root : JSON.parse(fs.readFileSync(path.join(root, '.build', 'last-release.json'), 'utf8')).folder);
    const report = compactRuntime(folder, { measureOnly: process.argv.includes('--measure'), executableOnly: process.argv.includes('--executable-only') });
    if (isWithin(path.join(root, 'out'), folder)) fs.writeFileSync(path.join(folder, 'runtime-footprint.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { compactRuntime };
