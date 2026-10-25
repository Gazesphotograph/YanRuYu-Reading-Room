'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const appSource = path.join(root, 'resources', 'app');
const appPackage = () => JSON.parse(fs.readFileSync(path.join(appSource, 'package.json'), 'utf8'));
const sourceTrees = ['dist', 'modules', 'fileLoader', 'public'];
const sourceFiles = ['index.js', 'preload.js', 'package.json', 'package-lock.json'];
const extras = ['7z.exe', '7z.dll', 'manga_reader.exe', 'License.txt'];
const privateSegment = /^(?:\.reading-room|\.data-protection|\.dev-data|\.artifacts|profiles?|\.?cache|code cache|gpucache|cover|viewer|backups?|recovery|restore-points|tmp|temp|local storage|session storage|network|sessions|\.env(?:\..*)?|cookies|credentials.*|secret_key\.json|(?:setting|collectionList|client-state|reading-state|ui-state|task-state|window-state|library-organizer|local-search)\.json(?:\..*)?|restore-journal\.json|.*\.yru-backup|bookList\.json(?:\..*)?|(?:database|metadata)\.sqlite(?:-.*)?|.*\.(?:sqlite|db)(?:-.*)?|.*\.log|log\.txt|preferences|local state)$/i;
const sourceExtension = /\.(?:js|cjs|mjs|ps1|json|css|html|svg|png|ico|jpg|jpeg|webp|woff2?|ttf|txt|md|map)$/i;

function isWithin(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function hasPrivatePath(relative) { return relative.split(/[\\/]/).some(segment => privateSegment.test(segment)); }
function sha256(filename) { return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
function walk(folder, { skipDirectories = new Set() } = {}) {
  const files = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not accepted in release source: ${absolute}`);
    if (entry.isDirectory()) {
      if (!skipDirectories.has(entry.name)) files.push(...walk(absolute, { skipDirectories }));
    }
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}
function listSourceFiles() {
  const files = sourceFiles.map(file => path.join(appSource, file));
  for (const folder of sourceTrees) files.push(...walk(path.join(appSource, folder)));
  for (const absolute of files) {
    const relative = path.relative(appSource, absolute);
    if (hasPrivatePath(relative) || !sourceExtension.test(relative)) throw new Error(`Unexpected or private source file: ${relative}`);
  }
  return files;
}
function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  const found = candidates.find(file => fs.existsSync(file) && /(?:npm|npm-cli)\.js$/i.test(file));
  if (!found) throw new Error('Run this command with npm, or install Node.js with its npm CLI.');
  return found;
}
function runNode(script, args = [], options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(script)} exited with ${result.status}`);
}
function npm(args, cwd, options = {}) { runNode(npmCli(), args, { cwd, ...options }); }
function electronExecutable() {
  // Electron 44 downloads lazily using Node's fetch. Honor the user's existing
  // HTTP(S) proxy without changing its address or disabling TLS validation.
  if ((process.env.HTTPS_PROXY || process.env.HTTP_PROXY) && process.env.NODE_USE_ENV_PROXY === undefined) {
    process.env.NODE_USE_ENV_PROXY = '1';
  }
  const electronHome = path.dirname(require.resolve('electron/package.json'));
  if (!fs.existsSync(path.join(electronHome, 'path.txt')) || !fs.existsSync(path.join(electronHome, 'dist', 'electron.exe'))) {
    runNode(path.join(__dirname, 'ensure-electron.cjs'));
  }
  return require('electron');
}
function uniqueDirectory(base, prefix) {
  if (!isWithin(root, base) || path.resolve(base) === root) throw new Error('Build output must remain inside the dedicated project output directory.');
  fs.mkdirSync(base, { recursive: true });
  const target = path.join(base, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(target); // Never overwrite an existing directory or live installation.
  return target;
}
function writePointer(name, payload) {
  const folder = path.join(root, '.build');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), JSON.stringify(payload, null, 2) + '\n');
}
function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

module.exports = { fs, path, root, appSource, appPackage, sourceTrees, sourceFiles, extras, isWithin, hasPrivatePath, sha256, walk, listSourceFiles, npm, runNode, electronExecutable, uniqueDirectory, writePointer, copyFile };
