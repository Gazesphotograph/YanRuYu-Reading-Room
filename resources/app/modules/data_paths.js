'use strict'

const fs = require('node:fs')
const path = require('node:path')

// The development entry may live under resources/app, just like the packaged app.
function programRoot(app) {
  if (app.isPackaged) return path.dirname(app.getPath('exe'))
  const appPath = path.resolve(app.getAppPath())
  return path.basename(appPath) === 'app' && path.basename(path.dirname(appPath)) === 'resources'
    ? path.dirname(path.dirname(appPath))
    : appPath
}

function existingDirectory(target) {
  try { return fs.statSync(target).isDirectory() } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function validateExplicitDataDirectory(value, root) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('YANRUYU_DATA_DIR must be a non-empty absolute directory path.')
  }
  const target = path.resolve(value)
  const relative = path.relative(root, target)
  if (target === path.parse(target).root || relative === '' ||
      relative === 'resources' || relative.startsWith(`resources${path.sep}`)) {
    throw new Error('YANRUYU_DATA_DIR must be a dedicated data directory, not a drive root or application resources.')
  }
  try {
    if (!fs.statSync(target).isDirectory()) throw new Error('YANRUYU_DATA_DIR points to a file, not a directory.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return target
}

function resolveDataPaths(app, env = process.env) {
  const root = programRoot(app)
  let storePath
  let mode
  if (Object.prototype.hasOwnProperty.call(env, 'YANRUYU_DATA_DIR')) {
    storePath = validateExplicitDataDirectory(env.YANRUYU_DATA_DIR, root)
    mode = 'explicit'
  } else if (!app.isPackaged) {
    // Never infer the live portable library during development.
    storePath = path.join(root, '.dev-data')
    mode = 'development'
  } else if (existingDirectory(path.join(root, 'data'))) {
    storePath = path.join(root, 'data')
    mode = 'portable-data'
  } else if (fs.existsSync(path.join(root, 'portable'))) {
    storePath = root
    mode = 'portable-legacy'
  } else {
    storePath = app.getPath('userData')
    mode = 'user-data'
  }
  return {
    root,
    storePath,
    profilePath: path.join(storePath, '.reading-room'),
    mode,
    isPortable: mode === 'portable-data' || mode === 'portable-legacy',
  }
}

module.exports = { programRoot, validateExplicitDataDirectory, resolveDataPaths }
