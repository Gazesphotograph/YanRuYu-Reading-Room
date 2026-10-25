'use strict';

const { fs, path, root, isWithin, hasPrivatePath, sha256, walk } = require('./common.cjs');

function auditRelease(folder) {
  folder = path.resolve(folder);
  if (!isWithin(path.join(root, 'out'), folder) || folder === path.join(root, 'out')) throw new Error('Audit expects one generated release below out/.');
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'build-manifest.json'), 'utf8'));
  const files = walk(folder);
  const forbidden = [];
  for (const file of files) {
    const relative = path.relative(folder, file).replaceAll(path.sep, '/');
    // Dependencies come from npm ci in a new staging directory, never from a
    // user's installation. Sample dependency fixtures are not application data.
    if (relative.startsWith('resources/app/node_modules/')) continue;
    if (hasPrivatePath(relative)) forbidden.push(relative);
  }
  if (forbidden.length) throw new Error(`Private-state paths found in release: ${forbidden.join(', ')}`);
  for (const [relative, expected] of Object.entries(manifest.sourceHashes)) {
    const absolute = path.resolve(folder, relative);
    if (!isWithin(folder, absolute) || sha256(absolute) !== expected) throw new Error(`Release source mismatch: ${relative}`);
  }
  if (!fs.existsSync(path.join(folder, 'exhentai-manga-manager.exe'))) throw new Error('Release executable missing.');
  if (manifest.executable) {
    if (manifest.executable.file !== 'exhentai-manga-manager.exe' || sha256(path.join(folder, manifest.executable.file)) !== manifest.executable.sha256) throw new Error('Release executable checksum mismatch.');
  }
  return {
    formatVersion: 1,
    checkedAt: new Date().toISOString(),
    appVersion: manifest.appVersion,
    filesChecked: files.length,
    sourceFilesVerified: Object.keys(manifest.sourceHashes).length,
    privateStatePaths: [],
    applicationSourceHashesMatch: true,
    executableHashMatches: Boolean(manifest.executable),
    dependencies: 'fresh npm ci --omit=dev from resources/app/package-lock.json',
    scope: 'allow-listed source packaging and private state path exclusion; not a general secret-content audit',
  };
}
if (require.main === module) {
  try {
    const folder = process.argv[2] || JSON.parse(fs.readFileSync(path.join(root, '.build/last-release.json'), 'utf8')).folder;
    console.log(JSON.stringify(auditRelease(folder), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { auditRelease };
