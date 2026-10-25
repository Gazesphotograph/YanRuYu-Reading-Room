'use strict';

const { fs, path, root, appSource, appPackage, extras, sha256, listSourceFiles, npm, runNode, uniqueDirectory, writePointer, copyFile } = require('./common.cjs');
const { pruneBuildDependencies } = require('./lean-runtime.cjs');

function build() {
  runNode(path.join(__dirname, 'check.cjs'));
  const files = listSourceFiles();
  const packageInfo = appPackage();
  const folder = uniqueDirectory(path.join(root, '.build'), `app-${packageInfo.version}`);
  const targetApp = path.join(folder, 'resources', 'app');
  const sourceHashes = {};
  for (const file of files) {
    const relative = path.relative(appSource, file);
    const target = path.join(targetApp, relative);
    copyFile(file, target);
    sourceHashes[`resources/app/${relative.replaceAll(path.sep, '/')}`] = sha256(target);
  }
  // Native JavaScript/CSS is the source. Copying is intentional; never rebuild the
  // customized classic manager from the incomplete upstream recovery tree.
  for (const filename of extras) {
    const relative = path.join('resources', 'extraResources', filename);
    const file = path.join(root, relative);
    copyFile(file, path.join(folder, relative));
    sourceHashes[relative.replaceAll(path.sep, '/')] = sha256(file);
  }
  npm(['ci', '--omit=dev', '--no-audit', '--no-fund'], targetApp);
  // npm can finish successfully while blocking native dependency install scripts.
  // Fail before packaging instead of shipping an application that cannot start.
  runNode('-e', ["require('sqlite3'); require('sharp'); console.log('Native runtime dependencies load successfully.');"], { cwd: targetApp });
  const dependencyPruning = pruneBuildDependencies(targetApp);
  const manifest = {
    formatVersion: 1,
    productName: packageInfo.productName,
    appVersion: packageInfo.version,
    electronVersion: require('../../package.json').devDependencies.electron,
    platform: process.platform,
    architecture: process.arch,
    sourceKind: 'customized-runtime-source-with-preserved-manager-bundle',
    upstreamTag: 'v1.6.15',
    upstreamCommit: 'a55570b9920da5ffdd6a698c771bbd9a9d52248f',
    sourceHashes,
    dependencyPruning,
  };
  fs.writeFileSync(path.join(folder, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writePointer('last-build.json', { folder, app: targetApp });
  console.log(`Application built from current source: ${folder}`);
  return { folder, app: targetApp, manifest };
}

if (require.main === module) {
  try { build(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
