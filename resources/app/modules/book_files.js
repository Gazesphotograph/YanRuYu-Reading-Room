'use strict'

const fs = require('fs/promises')
const path = require('path')
const { randomUUID } = require('crypto')
const { isWithin, assertWithin } = require('./safety')
const { validBookId } = require('./reading_state')
const { moveWithIdentity } = require('./library_identity')
const { sourceSignature } = require('./source_signature')

function createBookFileService({ getBook, getLibrary, saveLocation, trash, listImages, commit = operation => operation(), now = Date.now } = {}) {
  const previews = new Map()
  const find = async id => {
    if (!validBookId(id)) throw new Error('书籍 ID 无效')
    const book = await getBook(id)
    if (!book || !['folder', 'zip', 'archive'].includes(book.type)) throw new Error('书籍记录不存在或类型无效')
    return book
  }
  const source = async book => {
    const library = path.resolve(getLibrary())
    await assertWithin(library, book.filepath, true)
    const stat = await fs.lstat(book.filepath)
    if (stat.isSymbolicLink() || (book.type === 'folder' ? !stat.isDirectory() : !stat.isFile())) throw new Error('书籍来源类型已改变，请重新扫描')
    if (book.type !== 'folder' && !/\.(zip|cbz|rar|cbr|7z|cb7)$/i.test(book.filepath)) throw new Error('来源不是受支持的漫画压缩包')
    return library
  }
  const savePreview = value => {
    for (const [token, preview] of previews) if (preview.expires < now()) previews.delete(token)
    if (previews.size >= 30) previews.delete(previews.keys().next().value)
    const token = randomUUID(), preview = { ...value, token, expires: now() + 10 * 60 * 1000 }
    previews.set(token, preview)
    return { ...preview }
  }
  return {
    async previewMove(bookId, destination) {
      const book = await find(bookId), library = await source(book)
      if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('请选择书库中的目标文件夹')
      const to = path.resolve(destination, path.basename(book.filepath)), from = path.resolve(book.filepath)
      if (!isWithin(library, from) || !isWithin(library, to) || isWithin(from, to, true)) throw new Error('目标需要位于当前书库内，并且不能是书籍本身的子目录')
      await assertWithin(library, destination, true)
      if (!(await fs.stat(destination)).isDirectory()) throw new Error('目标不是文件夹')
      try { await fs.lstat(to); throw new Error('目标已有同名文件或文件夹，请选择其他位置') } catch (error) { if (error.code !== 'ENOENT') throw error }
      return savePreview({ kind:'move', bookId, library, from, to, signature:await sourceSignature(from, book.type, { libraryRoot:library }) })
    },
    async previewRecycle(bookId) {
      const book = await find(bookId), library = await source(book)
      const images = book.type === 'folder' ? await listImages(book.filepath) : []
      if (book.type === 'folder') for (const file of images) {
        await assertWithin(book.filepath, file)
        if (!(await fs.lstat(file)).isFile()) throw new Error('书页路径类型无效')
      }
      return savePreview({ kind:'recycle', bookId, library, from:path.resolve(book.filepath), imageCount:images.length, type:book.type,
        signature:await sourceSignature(book.filepath, book.type, { libraryRoot:library }) })
    },
    apply(token) {
      return commit(async () => {
        const preview = previews.get(token)
        if (!preview || preview.expires < now()) throw new Error('文件操作预览已过期，请重新选择')
        const book = await find(preview.bookId), library = await source(book)
        if (library !== preview.library || path.resolve(book.filepath) !== preview.from) throw new Error('书籍位置或书库目录已在预览后改变，请重新选择')
        if (await sourceSignature(preview.from, book.type, { libraryRoot:library }) !== preview.signature) throw new Error('书籍文件已在预览后改变，请重新预览')
        if (preview.kind === 'move') {
          await moveWithIdentity({ oldPath:preview.from, newPath:preview.to, type:book.type, libraryRoot:library,
            persist:fingerprint => saveLocation(book.id, { filepath:preview.to, identityFingerprint:fingerprint, exist:true }) })
          previews.delete(token)
          return { success:true, bookId:book.id, filepath:preview.to, kind:'move' }
        }
        let recycled = 0, filesRecycled = false
        try {
          if (book.type === 'folder') {
            const images = await listImages(preview.from)
            if (images.length !== preview.imageCount) throw new Error('书页数量已在预览后改变，请重新预览')
            for (const file of images) {
              await assertWithin(preview.from, file)
              if (!(await fs.lstat(file)).isFile()) throw new Error('书页路径类型无效')
            }
            for (const file of images) { await trash(file); recycled++ }
            const remaining = await fs.readdir(preview.from)
            if (!remaining.length && isWithin(library, preview.from)) await trash(preview.from)
          } else { await trash(preview.from); recycled = 1 }
          filesRecycled = true
          await saveLocation(book.id, { exist:false })
          previews.delete(token)
          return { success:true, bookId:book.id, recycled, kind:'recycle', recordRetained:true }
        } catch (error) {
          const detail = filesRecycled ? '文件已移入回收站，书库状态未能更新。' : recycled ? `已将 ${recycled} 项移入系统回收站，其余文件和书库记录保留。` : '文件和书库记录未改变。'
          throw new Error(detail + error.message)
        }
      })
    }
  }
}

module.exports = { createBookFileService }
