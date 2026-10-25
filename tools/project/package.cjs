'use strict';

const { fs, path, root, uniqueDirectory, writePointer, copyFile, hasPrivatePath, walk, electronExecutable, sha256 } = require('./common.cjs');
const { build } = require('./build.cjs');
const { auditRelease } = require('./audit.cjs');
const { brandExecutable } = require('./brand-executable.cjs');
const { keepRuntimeFile, runtimeLocales } = require('./lean-runtime.cjs');
const { compactRuntime } = require('./compact.cjs');
const { spawnSync } = require('node:child_process');

function packageApp() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The bundled 7-Zip/reader support Windows x64 packaging only.');
  const built = build();
  const folder = uniqueDirectory(path.join(root, 'out'), `yanruyu-${built.manifest.appVersion}-win32-x64`);
  const electronPath = electronExecutable();
  const electronDist = path.dirname(electronPath);
  for (const file of walk(electronDist)) {
    const relative = path.relative(electronDist, file);
    if (!keepRuntimeFile(relative)) continue;
    if (hasPrivatePath(relative)) throw new Error(`Unexpected runtime state in Electron distribution: ${relative}`);
    copyFile(file, path.join(folder, relative === 'electron.exe' ? 'exhentai-manga-manager.exe' : relative));
  }
  fs.cpSync(path.join(built.folder, 'resources'), path.join(folder, 'resources'), { recursive: true, force: false, errorOnExist: true, dereference: false });
  const executable = path.join(folder, 'exhentai-manga-manager.exe');
  brandExecutable(executable, path.join(folder, 'resources', 'app', 'public', 'icon.ico'));
  const compactScript = path.join(__dirname, 'compact-runtime.ps1');
  copyFile(compactScript, path.join(folder, '优化程序磁盘占用.ps1'));
  copyFile(path.join(root, 'LICENSE'), path.join(folder, 'YANRUYU-LICENSE.txt'));
  fs.writeFileSync(path.join(folder, 'build-manifest.json'), JSON.stringify({
    ...built.manifest,
    sourceHashes: { ...built.manifest.sourceHashes, '优化程序磁盘占用.ps1': sha256(compactScript) },
    runtimeLocales: [...runtimeLocales],
    executable: { file: 'exhentai-manga-manager.exe', sha256: sha256(executable), icon: 'resources/app/public/icon.ico', resourceEditor: 'rcedit@5.0.2' },
  }, null, 2) + '\n');
  copyFile(path.join(root, 'docs', '使用与升级.md'), path.join(folder, '使用与升级.md'));
  const audit = auditRelease(folder);
  fs.writeFileSync(path.join(folder, 'release-audit.json'), JSON.stringify(audit, null, 2) + '\n');
  let footprint;
  try {
    footprint = compactRuntime(folder);
    fs.writeFileSync(path.join(folder, 'runtime-footprint.json'), JSON.stringify(footprint, null, 2) + '\n');
  } catch (error) {
    // FAT/exFAT and non-NTFS destinations remain usable without compression.
    console.warn('Runtime compression unavailable: ' + error.message);
  }
  const archive = folder + '.zip';
  const zipResult = spawnSync(path.join(root, 'resources', 'extraResources', '7z.exe'), ['a', '-tzip', '-mx=7', '-mmt=2', archive, '*'], {
    cwd: folder, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  if (zipResult.error || zipResult.status !== 0) throw new Error(zipResult.error?.message || zipResult.stderr || 'Release archive could not be created.');
  const archiveCheck = spawnSync(path.join(root, 'resources', 'extraResources', '7z.exe'), ['t', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (archiveCheck.error || archiveCheck.status !== 0) throw new Error('Release archive verification failed.');
  writePointer('last-release.json', { folder, archive, archiveBytes: fs.statSync(archive).size });
  console.log(`Clean unpacked release: ${folder}`);
  console.log('Existing installations and user data have not been updated.');
  console.log(`Verified ZIP release: ${archive} (${fs.statSync(archive).size} bytes)`);
  return { folder, archive, audit, footprint };
}

if (require.main === module) {
  try { packageApp(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { packageApp };
