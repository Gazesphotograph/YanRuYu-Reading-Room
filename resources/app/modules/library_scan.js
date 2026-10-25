'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createIdentityResolver, fingerprintBook, mergeRebuiltBook, confirmedMissing, canRelocateSource, pathKey } = require('./library_identity')
const { assertWithin, isWithin, hashFile } = require('./safety')
const { sourceSignature, checkCancelled } = require('./source_signature')

const plain = book => typeof book.toJSON === 'function' ? book.toJSON() : book
const aborted = error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
const mergeRelation = (sources, id) => Object.hasOwn(sources, id) ? JSON.stringify(sources[id]) : ''

// Expensive discovery, hashing and cover generation happen outside the short
// write queue. The final transaction merges the latest user fields, so reading,
// favourites and basic browsing can continue while a scan prepares its changes.
async function scanLibrary({ Manga, library, excludeFile, excludeRoots = [], coverRoot, getBookFilelist, geneCover,
  clearTemp = async () => {}, progress = () => {}, message = () => {}, onItem = () => {}, onError = () => {}, newId,
  fingerprint = fingerprintBook, signature = sourceSignature, sampleHash = hashFile, rebuild = false,
  forceRefresh = false, paths = null, signal, commit = operation => operation(), beforeCommit = () => {},
  getMergedSources = async () => ({}) }) {
  if (!library) throw new Error('请先选择书库目录')
  checkCancelled(signal)
  const { previousBooks, mergedSources } = await commit(async () => ({
    previousBooks: (await Manga.findAll()).map(plain), mergedSources: await getMergedSources()
  }))
  await fs.promises.readdir(library) // An unavailable drive is never an empty library.
  onItem({ phase: 'discover', current: 0, total: 0, message: '正在查找书籍文件…' })
  let files = await getBookFilelist(library, { signal })
  checkCancelled(signal)
  files = files.filter(file => !excludeRoots.some(root => root && isWithin(root, file.filepath, true)))
  let excluded
  if (excludeFile) {
    try { excluded = new RegExp(excludeFile) }
    catch { throw new Error('书库排除规则不是有效的正则表达式，原书库保持不变') }
    files = files.filter(file => !excluded.test(file.filepath))
  }
  files = [...new Map(files.map(file => [pathKey(file.filepath), file])).values()]
  const selectedPaths = paths ? new Set(paths.map(pathKey)) : null
  if (selectedPaths) files = files.filter(file => selectedPaths.has(pathKey(file.filepath)))
  message(`正在${rebuild ? '重建' : forceRefresh ? '刷新本地元数据' : '扫描'}书库，共 ${files.length} 本`)
  const result = { changed: false, count: previousBooks.length, failures: 0, errors: [], processed: 0,
    added: 0, updated: 0, unchanged: 0, relocated: 0, cancelled: false }
  const fail = (filepath, error, phase = 'book') => {
    const failure = { filepath, message: error.message || String(error), phase }
    result.failures++
    result.errors.push(failure)
    onError(failure)
    message(`书籍处理失败，原记录已保留：${filepath}；${failure.message}`)
  }
  if (!files.length) {
    message('本次未发现书籍，将保留全部旧记录和封面，并检查已确认失联的路径')
  }
  const resolver = createIdentityResolver(previousBooks, files, { libraryRoot: library, mergedSources })
  const prepared = new Map()
  const generatedCovers = new Set()
  const retainedCovers = new Set()
  const supersededCovers = []
  let committed = false
  const removeCover = async cover => {
    try { await assertWithin(coverRoot, cover); await fs.promises.unlink(cover) }
    catch (error) { if (error.code !== 'ENOENT') message('部分临时封面暂未清理，书库数据保持可用') }
  }
  try {
    await clearTemp()
    for (let index = 0; index < files.length; index++) {
      if (signal?.aborted) { result.cancelled = true; break }
      const { filepath, type } = files[index]
      onItem({ phase: 'inspect', current: index, total: files.length, filepath,
        message: `检查 ${index + 1} / ${files.length}：${path.basename(filepath)}` })
      try {
        await assertWithin(library, filepath, type === 'folder')
        const observed = await signature(filepath, type, { libraryRoot: library, signal })
        const atPath = resolver.atPath(filepath)
        let previous = atPath
        const contentChanged = !previous?.sourceSignature || observed !== previous.sourceSignature
        const identityFingerprint = !previous?.identityFingerprint || rebuild || contentChanged
          ? await fingerprint(filepath, type, { libraryRoot: library, signal }) : previous.identityFingerprint
        checkCancelled(signal)
        if (!previous) previous = await resolver.relocated(filepath, type, identityFingerprint)
        const relocated = !!previous && !atPath
        let coverExists = false
        if (previous?.coverPath) {
          try { await fs.promises.access(path.join(coverRoot, path.basename(previous.coverPath))); coverExists = true } catch {}
        }
        let candidate
        const needsRefresh = rebuild || forceRefresh || !previous || contentChanged || !coverExists
        if (needsRefresh) {
          onItem({ phase: 'cover', current: index, total: files.length, filepath,
            message: `更新页数与封面：${path.basename(filepath)}` })
          const generated = await geneCover(filepath, type, { signal })
          if (generated.coverPath) generatedCovers.add(generated.coverPath)
          if (!generated.targetFilePath || !generated.coverPath) throw new Error('没有生成有效封面')
          const sample = await sampleHash(generated.targetFilePath)
          checkCancelled(signal)
          const after = await signature(filepath, type, { libraryRoot: library, signal })
          if (after !== observed) throw new Error('文件在扫描过程中发生变化，请稍后重试')
          candidate = mergeRebuiltBook(previous, {
            id: previous?.id || newId(), title: path.basename(filepath), filepath, type,
            coverPath: generated.coverPath, hash: sample, identityFingerprint, sourceSignature: observed,
            pageCount: generated.pageCount, bundleSize: generated.bundleSize,
            mtime: generated.mtime.toJSON(), coverHash: generated.coverHash,
            status: 'non-tag', exist: true, date: Date.now()
          })
        } else {
          candidate = { ...previous, filepath, type, identityFingerprint, sourceSignature: observed, exist: true,
            coverPath: previous.coverPath ? path.join(coverRoot, path.basename(previous.coverPath)) : previous.coverPath }
        }
        if (previous) resolver.claim(previous)
        const changed = !previous || needsRefresh || relocated || previous.exist === false || previous.exist === 0 ||
          previous.coverPath !== candidate.coverPath
        prepared.set(candidate.id, { candidate, previous, changed, relocated, refreshed: needsRefresh })
      } catch (error) {
        if (aborted(error) || signal?.aborted) { result.cancelled = true; break }
        fail(filepath, error)
      }
      result.processed = index + 1
      progress((index + 1) / files.length)
      onItem({ current: index + 1, total: files.length })
      if ((index + 1) % 50 === 0) await clearTemp()
    }
    if (rebuild && (result.failures || result.cancelled)) {
      message('重建未提交，全部旧书目和用户数据保持不变')
      return result
    }
    // A cancelled incremental scan keeps successfully prepared books; retrying
    // then skips them. Never mark unvisited records missing after cancellation.
    const missing = []
    if (!result.cancelled && !selectedPaths) {
      for (const previous of previousBooks) {
        if (excluded?.test(previous.filepath) || excludeRoots.some(root => root && isWithin(root, previous.filepath, true))) continue
        if (!mergedSources[previous.id] && !resolver.isClaimed(previous.id) && await confirmedMissing(previous.filepath, library)) missing.push(previous)
      }
    }
    onItem({ phase: 'save', message: result.cancelled ? '正在保存已完成的书目…' : '正在保存书库变化…' })
    await commit(async () => {
      await beforeCommit()
      if (rebuild) checkCancelled(signal)
      else if (signal?.aborted) result.cancelled = true
      const latestBooks = (await Manga.findAll()).map(plain)
      const byId = new Map(latestBooks.map(book => [book.id, book]))
      const latestMergedSources = await getMergedSources()
      const latestResolver = createIdentityResolver(latestBooks, files, { libraryRoot: library, mergedSources: latestMergedSources })
      const accepted = []
      for (const entry of prepared.values()) {
        const { candidate, previous, changed } = entry
        try {
          const latest = byId.get(candidate.id)
          if (previous && (!latest || pathKey(latest.filepath) !== pathKey(previous.filepath))) {
            throw new Error('此书的记录在扫描时已移动或删除，已保留最新操作')
          }
          if (mergeRelation(latestMergedSources, candidate.id) !== mergeRelation(mergedSources, candidate.id)) {
            throw new Error('此书的合并关系在扫描时已改变，已保留最新整理结果')
          }
          const occupied = latestResolver.atPath(candidate.filepath)
          if (occupied && occupied.id !== candidate.id) throw new Error('目标路径已被另一书籍记录使用，未自动合并')
          if (entry.relocated && (latest.identityFingerprint !== candidate.identityFingerprint ||
              !(await canRelocateSource(latest.filepath, library)) ||
              (await latestResolver.relocated(candidate.filepath, candidate.type, candidate.identityFingerprint))?.id !== candidate.id)) {
            throw new Error('原书籍路径已恢复或匹配记录已改变，未自动迁移；请重新扫描')
          }
          if (changed && await signature(candidate.filepath, candidate.type, { libraryRoot: library, signal: rebuild ? signal : undefined }) !== candidate.sourceSignature) {
            throw new Error('保存前发现书籍文件发生变化，请重试')
          }
          accepted.push({ ...entry, latest, book: latest ? mergeRebuiltBook(latest, candidate) : candidate })
          if (latest) latestResolver.claim(latest)
        } catch (error) {
          if (rebuild) throw error
          fail(candidate.filepath, error, 'commit')
        }
      }
      await Manga.sequelize.transaction(async transaction => {
        for (const entry of accepted) {
          if (rebuild) checkCancelled(signal)
          if (!entry.changed) { result.unchanged++; retainedCovers.add(entry.book.coverPath); continue }
          if (entry.latest) await Manga.update(entry.book, { where: { id: entry.book.id }, transaction })
          else await Manga.create(entry.book, { transaction })
          retainedCovers.add(entry.book.coverPath)
          if (entry.latest?.coverPath && entry.latest.coverPath !== entry.book.coverPath) supersededCovers.push(entry.latest.coverPath)
          if (!entry.latest) result.added++
          else if (entry.relocated) result.relocated++
          else result.updated++
          result.changed = true
        }
        for (const previous of missing) {
          if (rebuild) checkCancelled(signal)
          const latest = byId.get(previous.id)
          if (!latest || pathKey(latest.filepath) !== pathKey(previous.filepath) || latest.exist === false || latest.exist === 0) continue
          if (!(await confirmedMissing(latest.filepath, library))) continue
          await Manga.update({ exist: false }, { where: { id: latest.id }, transaction })
          result.changed = true
        }
        if (rebuild) checkCancelled(signal)
      })
      result.count = latestBooks.length + result.added
      committed = true
    })
    // Other rows can share a legacy cover. Delete only after checking the
    // committed library, never while a replacement is still staged.
    const committedCovers = new Set((await commit(async () => (await Manga.findAll({ attributes: ['coverPath'], raw: true }))))
      .map(book => book.coverPath).filter(Boolean).map(pathKey))
    for (const cover of supersededCovers) if (!committedCovers.has(pathKey(cover))) await removeCover(cover)
    return result
  } catch (error) {
    if (aborted(error) && !committed) {
      return { ...result, changed: false, count: previousBooks.length, cancelled: true,
        added: 0, updated: 0, unchanged: 0, relocated: 0 }
    }
    throw error
  } finally {
    for (const cover of generatedCovers) if (!committed || !retainedCovers.has(cover)) await removeCover(cover)
    await clearTemp()
    progress(-1)
  }
}

// Manual relocation is explicit but still verifies the complete content. A
// selected copy must not steal another book's identity or replace a live path.
async function relocateMissingBook({ Manga, bookId, filepath, library, coverRoot, geneCover,
  signal, fingerprint = fingerprintBook, signature = sourceSignature, sampleHash = hashFile,
  commit = operation => operation() }) {
  const previous = await commit(async () => {
    const row = await Manga.findByPk(bookId)
    if (!row) throw new Error('书籍记录不存在')
    return plain(row)
  })
  if (!(await canRelocateSource(previous.filepath, library))) throw new Error('原路径仍存在或暂时无法确认失联，未重新定位')
  if (!previous.identityFingerprint) throw new Error('此旧书目尚无完整内容指纹，无法安全确认新文件，请先恢复原路径后扫描')
  if (pathKey(previous.filepath) === pathKey(filepath)) throw new Error('请选择书籍移动后的新路径')
  await assertWithin(library, filepath, previous.type === 'folder')
  const observed = await signature(filepath, previous.type, { libraryRoot: library, signal })
  const identityFingerprint = await fingerprint(filepath, previous.type, { libraryRoot: library, signal })
  if (identityFingerprint !== previous.identityFingerprint) throw new Error('选择的文件与原书内容不一致，已保留原书目和阅读档案')
  const generated = await geneCover(filepath, previous.type, { signal })
  let saved = false
  try {
    checkCancelled(signal)
    const hash = await sampleHash(generated.targetFilePath)
    const result = await commit(async () => {
      const all = (await Manga.findAll()).map(plain)
      const latest = all.find(book => book.id === bookId)
      if (!latest || latest.filepath !== previous.filepath) throw new Error('书籍记录已改变，请重新定位')
      if (latest.identityFingerprint !== identityFingerprint) throw new Error('原书籍内容记录已改变，请重新定位')
      if (!(await canRelocateSource(latest.filepath, library))) throw new Error('原书籍路径已恢复，未更改记录')
      if (all.some(book => book.id !== bookId && pathKey(book.filepath) === pathKey(filepath))) throw new Error('选择的路径已有独立书目，未合并两个阅读档案')
      if (await signature(filepath, latest.type, { libraryRoot: library, signal }) !== observed) throw new Error('选择的文件正在变化，请稍后重试')
      const book = mergeRebuiltBook(latest, { filepath, type: latest.type, identityFingerprint,
        sourceSignature: observed, coverPath: generated.coverPath, hash, coverHash: generated.coverHash,
        pageCount: generated.pageCount, bundleSize: generated.bundleSize, mtime: generated.mtime.toJSON(), exist: true })
      await Manga.update(book, { where: { id: book.id } })
      saved = true
      return book
    })
    return result
  } finally {
    if (!saved && generated.coverPath) {
      try { await assertWithin(coverRoot, generated.coverPath); await fs.promises.unlink(generated.coverPath) } catch {}
    }
  }
}

module.exports = { scanLibrary, relocateMissingBook }
