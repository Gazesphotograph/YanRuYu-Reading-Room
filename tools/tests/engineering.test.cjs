'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { resolveDataPaths, validateExplicitDataDirectory, programRoot } = require('../../resources/app/modules/data_paths');
const { hasPrivatePath, listSourceFiles, isWithin } = require('../project/common.cjs');
const { keepRuntimeFile, keepDependencyFile } = require('../project/lean-runtime.cjs');

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-path-check-'));
  const program = path.join(dir, 'program');
  fs.mkdirSync(path.join(program, 'resources', 'app'), { recursive: true });
  const app = {
    isPackaged: true,
    getAppPath: () => path.join(program, 'resources', 'app'),
    getPath: name => name === 'exe' ? path.join(program, 'exhentai-manga-manager.exe') : path.join(dir, 'system-user-data'),
  };
  try { return fn({ dir, program, app }); }
  finally {
    assert.ok(isWithin(os.tmpdir(), dir) && path.basename(dir).startsWith('yanruyu-path-check-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('legacy portable store and existing browser profile remain at the old paths', () => fixture(({ program, app }) => {
  fs.writeFileSync(path.join(program, 'portable'), '');
  const result = resolveDataPaths(app, {});
  assert.equal(result.storePath, program);
  assert.equal(result.profilePath, path.join(program, '.reading-room'));
  assert.equal(result.mode, 'portable-legacy');
  assert.equal(result.isPortable, true);
}));

test('portable data directory takes precedence over the legacy marker', () => fixture(({ program, app }) => {
  fs.writeFileSync(path.join(program, 'portable'), '');
  fs.mkdirSync(path.join(program, 'data'));
  assert.equal(resolveDataPaths(app, {}).storePath, path.join(program, 'data'));
}));

test('development ignores the live portable marker and live data folder', () => fixture(({ program, app }) => {
  fs.writeFileSync(path.join(program, 'portable'), '');
  fs.mkdirSync(path.join(program, 'data'));
  app.isPackaged = false;
  const result = resolveDataPaths(app, {});
  assert.equal(programRoot(app), program);
  assert.equal(result.storePath, path.join(program, '.dev-data'));
  assert.equal(result.isPortable, false);
}));

test('explicit absolute data directory isolates packaged and source launches', () => fixture(({ dir, program, app }) => {
  fs.writeFileSync(path.join(program, 'portable'), '');
  const isolated = path.join(dir, 'isolated');
  for (const packaged of [true, false]) {
    app.isPackaged = packaged;
    const result = resolveDataPaths(app, { YANRUYU_DATA_DIR: isolated });
    assert.equal(result.storePath, isolated);
    assert.equal(result.profilePath, path.join(isolated, '.reading-room'));
    assert.equal(result.isPortable, false);
  }
}));

test('fresh nonportable package uses system user data instead of its program folder', () => fixture(({ app }) => {
  const result = resolveDataPaths(app, {});
  assert.equal(result.storePath, app.getPath('userData'));
  assert.equal(result.mode, 'user-data');
}));

test('invalid explicit path fails closed without silently choosing the live library', () => fixture(({ dir, program, app }) => {
  const file = path.join(dir, 'ordinary-file');
  fs.writeFileSync(file, 'sentinel');
  for (const value of ['', '  ', './relative', program, path.join(program, 'resources'), path.join(program, 'resources', 'app'), path.parse(dir).root, file, 'bad\0path']) {
    assert.throws(() => resolveDataPaths(app, { YANRUYU_DATA_DIR: value }));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'sentinel');
}));

test('build source list contains custom reader and classic manager', () => {
  const sources = listSourceFiles().map(file => file.replaceAll(path.sep, '/'));
  for (const suffix of ['/dist/room.js', '/dist/room-entry.js', '/dist/room-scene.js', '/dist/manager-theme.js', '/dist/assets/index-Db6-k1a1.js']) {
    assert.ok(sources.some(file => file.endsWith(suffix)), suffix);
  }
  assert.ok(sources.every(file => !file.includes('/node_modules/')));
});

test('release privacy filter excludes databases, settings, credentials and browser profiles', () => {
  for (const file of ['database.sqlite', 'metadata.sqlite-wal', 'data/setting.json', '.reading-room/Preferences', 'cover/private.webp', 'backups/anything', 'nested/client-state.json', 'ui-state.json', 'reading-state.json', '.data-protection/restore-points/index.json', 'backup.yru-backup', 'tmp/a.js', '.env.local', 'secret_key.json']) assert.equal(hasPrivatePath(file), true, file);
  for (const file of ['modules/backup_service.js', 'modules/client_state.js', 'dist/client-state.js', 'public/icon.ico']) assert.equal(hasPrivatePath(file), false, file);
  for (const file of ['local-search.json', 'data/library-organizer.json', 'data/local-search.json.123.tmp']) assert.equal(hasPrivatePath(file), true, file);
});

test('lean packaging preserves runtime data and licenses while omitting development-only content', () => {
  for (const file of ['locales/zh-CN.pak', 'locales/zh-TW.pak', 'locales/en-US.pak', 'locales/en-GB.pak', 'dxcompiler.dll', 'LICENSES.chromium.html']) assert.equal(keepRuntimeFile(file), true, file);
  for (const file of ['locales/de.pak', 'resources/default_app.asar']) assert.equal(keepRuntimeFile(file), false, file);
  for (const file of ['sqlite3/build/Release/node_sqlite3.node', '@img/sharp-win32-x64/lib/sharp-win32-x64.node', 'moment-timezone/data/packed/latest.json', 'sharp/lib/index.js', 'package/package.json', 'package/docs/LICENSE.md', 'package/NOTICE']) assert.equal(keepDependencyFile(file), true, file);
  for (const file of ['package/tests/test.js', 'package/README.md', 'package/index.d.ts', 'package/index.js.map', 'package/.github/workflows/test.yml']) assert.equal(keepDependencyFile(file), false, file);
});

test('import cleanup uses its owned cache while historical tmp files remain untouched', () => fixture(({ dir, program, app }) => {
  const isolated = path.join(dir, 'isolated');
  const oldTemp = path.join(isolated, 'tmp');
  fs.mkdirSync(oldTemp, { recursive: true });
  fs.writeFileSync(path.join(oldTemp, 'user-work.txt'), 'keep');
  const module = { exports: {} };
  const initFile = path.join(__dirname, '../../resources/app/modules/init_folder_setting.js');
  vm.runInNewContext(fs.readFileSync(initFile, 'utf8'), {
    module, console, require(name) {
      if (name === 'electron') return { app };
      if (name === './utils.js') return { getRootPath: () => program };
      if (name === './data_paths.js') return { resolveDataPaths: () => resolveDataPaths(app, { YANRUYU_DATA_DIR: isolated }) };
      return require(name);
    },
  }, { filename: initFile });
  const { TEMP_PATH, preparePath } = module.exports;
  preparePath();
  assert.equal(TEMP_PATH, path.join(isolated, '.cache', 'import-temp'));
  assert.ok(isWithin(isolated, TEMP_PATH));
  fs.rmSync(TEMP_PATH, { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(oldTemp, 'user-work.txt'), 'utf8'), 'keep');
}));
