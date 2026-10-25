'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { assertWithin } = require('./safety')

const IMAGE_EXTENSION = /\.(jpg|jpeg|png|webp|avif|gif)$/i

function checkCancelled(signal) {
  if (!signal?.aborted) return
  const error = new Error('任务已取消，已保存的书目保持可用')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  throw error
}

// A directory's own timestamp does not change when an existing page is edited.
// Include every direct image entry and its file metadata, without decoding pages
// or reading their contents on an unchanged scan.
async function sourceSignature(filepath, type, { libraryRoot, signal } = {}) {
  checkCancelled(signal)
  if (libraryRoot) await assertWithin(libraryRoot, filepath, type === 'folder')
  const stat = await fs.promises.lstat(filepath)
  if (stat.isSymbolicLink()) throw new Error('书籍路径不能是链接')
  const values = value => [value.size, value.mtimeMs, value.ctimeMs, value.ino]
  if (type !== 'folder') {
    if (!stat.isFile()) throw new Error('压缩包不是普通文件')
    return 'file-stat-v1:' + createHash('sha256').update(JSON.stringify(values(stat))).digest('hex')
  }
  if (!stat.isDirectory()) throw new Error('书籍目录不存在')
  const entries = (await fs.promises.readdir(filepath, { withFileTypes: true }))
    .filter(entry => IMAGE_EXTENSION.test(entry.name))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  if (!entries.length) throw new Error('书籍目录没有图片')
  const hash = createHash('sha256').update('folder-stat-v1\0')
  for (const entry of entries) {
    checkCancelled(signal)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('书籍图片包含不支持的链接或目录')
    const page = await fs.promises.lstat(path.join(filepath, entry.name))
    if (!page.isFile() || page.isSymbolicLink()) throw new Error('扫描过程中图片路径发生变化')
    hash.update(JSON.stringify([entry.name, ...values(page)]) + '\n')
  }
  checkCancelled(signal)
  return 'folder-stat-v1:' + hash.digest('hex')
}

module.exports = { sourceSignature, checkCancelled }
