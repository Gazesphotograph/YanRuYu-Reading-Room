'use strict';

// Electron 44 has a lazy downloader. Keep initial setup bounded and verify the
// official package-provided checksum; use only the caller's existing proxy.
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This project currently supports Windows x64.');
  const electronHome = path.dirname(require.resolve('electron/package.json'));
  const { version } = require(path.join(electronHome, 'package.json'));
  const { downloadArtifact } = await import('@electron/get');
  const { extract } = require('@electron-internal/extract-zip');
  let lastProgress = -16;
  const zip = await downloadArtifact({
    version, artifactName: 'electron', platform: process.platform, arch: process.arch,
    checksums: require(path.join(electronHome, 'checksums.json')),
    downloadOptions: {
      quiet: true,
      signal: AbortSignal.timeout(180000),
      getProgressCallback: ({ transferred, total }) => {
        const megabytes = Math.floor(transferred / 1024 / 1024);
        if (megabytes >= lastProgress + 16 || transferred === total) {
          lastProgress = megabytes;
          console.log(`Electron ${version}: downloaded ${megabytes} MiB${total ? ` / ${Math.ceil(total / 1024 / 1024)} MiB` : ''}`);
        }
      },
    },
  });
  await extract(zip, { dir: path.join(electronHome, 'dist') });
  fs.writeFileSync(path.join(electronHome, 'path.txt'), 'electron.exe');
  console.log(`Electron ${version} downloaded and checksum verified.`);
}
main().catch(error => { console.error(`Electron setup failed: ${error.message}`); process.exitCode = 1; });
