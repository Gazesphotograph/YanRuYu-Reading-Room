'use strict';

const { fs, path, root, isWithin, walk } = require('./common.cjs');

const runtimeLocales = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
const developmentDirectories = new Set(['test', 'tests', '__tests__', 'benchmark', 'benchmarks', 'example', 'examples', 'docs', 'coverage', '.github']);

function keepRuntimeFile(relative) {
  const normalized = relative.replaceAll('\\', '/');
  if (normalized === 'resources/default_app.asar') return false;
  if (normalized.startsWith('locales/')) return runtimeLocales.has(path.posix.basename(normalized));
  return true;
}

function keepDependencyFile(relative) {
  const normalized = relative.replaceAll('\\', '/');
  const parts = normalized.split('/');
  const filename = parts.at(-1);
  // Preserve copyright notices even when a package puts them in its docs tree.
  if (/^(?:licen[sc]e|copying|notice|copyright)(?:[._-].*)?$/i.test(filename)) return true;
  if (parts.some(part => developmentDirectories.has(part.toLowerCase()))) return false;
  if (/\.(?:map|[cm]?ts|tsbuildinfo|md|markdown)$/i.test(filename)) return false;
  if (/^(?:\.npmignore|\.editorconfig|\.eslintrc.*|\.prettierrc.*|\.travis\.yml|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(filename)) return false;
  return true;
}

function pruneBuildDependencies(appFolder) {
  appFolder = path.resolve(appFolder);
  const buildRoot = path.join(root, '.build');
  if (!isWithin(buildRoot, appFolder) || !/^app-/.test(path.relative(buildRoot, appFolder).split(path.sep)[0]) || path.basename(appFolder) !== 'app') {
    throw new Error('Dependency pruning only accepts a newly generated application staging directory.');
  }
  const dependencies = path.join(appFolder, 'node_modules');
  let filesRemoved = 0, bytesRemoved = 0;
  for (const file of walk(dependencies)) {
    const resolved = path.resolve(file);
    if (!isWithin(dependencies, resolved) || resolved === dependencies) throw new Error('Unexpected dependency output path.');
    if (!keepDependencyFile(path.relative(dependencies, resolved))) {
      bytesRemoved += fs.statSync(resolved).size;
      fs.unlinkSync(resolved);
      filesRemoved++;
    }
  }
  return { filesRemoved, bytesRemoved, retained: 'Runtime JavaScript, native modules, data, package metadata and licenses' };
}

module.exports = { keepRuntimeFile, keepDependencyFile, pruneBuildDependencies, runtimeLocales };
