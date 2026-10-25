const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')

function isWithin(root, target, allowRoot = false) {
  if (typeof root !== 'string' || !root || typeof target !== 'string' || !target) return false
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return (!rel ? allowRoot : rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

async function assertWithin(root, target, allowRoot = false) {
  if (!isWithin(root, target, allowRoot)) throw new Error('Path is outside the allowed folder')
  const [realRoot, realTarget] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(target)])
  if (!isWithin(realRoot, realTarget, allowRoot)) throw new Error('Linked path is outside the allowed folder')
  return realTarget
}

function safeEntry(name) {
  if (typeof name !== 'string' || !name || /[\x00-\x1f:*?"<>|]/.test(name) || /^[\\/]/.test(name)) throw new Error('Unsafe archive entry')
  const parts = name.replace(/\\/g, '/').replace(/\/$/, '').split('/')
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe archive entry')
  return name
}

function webURL(value, hosts) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (hosts && (!hosts.includes(url.hostname) || url.protocol !== 'https:' || url.port))) throw new Error('URL is not allowed')
  return url.href
}

function readerExecutable(value) {
  const executable = String(value).trim().replace(/^"([^"\r\n]+)"$/, '$1')
  if (!path.isAbsolute(executable) || /["\r\n]/.test(executable) || path.extname(executable).toLowerCase() !== '.exe') throw new Error('Select a reader executable (.exe) in settings')
  return executable
}

async function hashFile(filepath) {
  const hash = createHash('sha1')
  for await (const chunk of fs.createReadStream(filepath)) hash.update(chunk)
  return hash.digest('hex')
}

function serialQueue() {
  let tail = Promise.resolve()
  return task => {
    const result = tail.then(task)
    tail = result.catch(() => {})
    return result
  }
}

module.exports = { isWithin, assertWithin, safeEntry, webURL, readerExecutable, hashFile, serialQueue }
