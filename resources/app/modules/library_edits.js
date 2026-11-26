'use strict'

const sqlite3 = require('sqlite3')
const { open } = require('sqlite')

// Renderer book objects can outlive an incremental scan. Only a main-process
// cover operation may intentionally replace its generated cover; stale reader
// saves must not restore old page counts or already retired cover files.
const SOURCE_FIELDS = ['id', 'filepath', 'type', 'coverPath', 'hash', 'pageCount', 'bundleSize', 'mtime', 'coverHash',
  'identityFingerprint', 'sourceSignature', 'exist', 'createdAt']

function mergeBookEdits(previous, incoming, approvedCover) {
  const result = { ...previous, ...incoming }
  for (const field of SOURCE_FIELDS) result[field] = previous[field]
  result.date = previous.date ?? incoming.date
  result.readCount = Math.max(Number(previous.readCount) || 0, Number(incoming.readCount) || 0)
  if (approvedCover) {
    result.coverPath = approvedCover.coverPath
    result.coverHash = approvedCover.coverHash
  }
  return result
}

function withBookAuthors(book, authors) {
  if (!Array.isArray(authors) || authors.some(name => typeof name !== 'string' || !name.trim())) {
    throw new Error('每位作者需要一个有效名称')
  }
  let tags = book.tags
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags) } catch { throw new Error('现有标签无法解析，请先核对书籍元数据') }
  }
  if (tags != null && (typeof tags !== 'object' || Array.isArray(tags))) throw new Error('现有标签格式异常，请先核对书籍元数据')
  return { ...book, tags: { ...tags, artist: [...new Set(authors.map(name => name.trim()))] } }
}

function columnValue(field, value) {
  if (field === 'tags' && value !== null) return JSON.stringify(value)
  return typeof value === 'boolean' ? Number(value) : value
}

async function writeBookEdit(Manga, Metadata, saved) {
  const database = await open({ filename: Manga.sequelize.options.storage, driver: sqlite3.Database, mode: sqlite3.OPEN_READWRITE })
  const now = new Date()
  const timestamp = Manga.rawAttributes.updatedAt.type.stringify(now, { timezone: '+00:00' })
  // Identifiers come from the two application models, values from the book.
  const mangaTable = Manga.getTableName(), metadataTable = Metadata.getTableName()
  const fields = Object.keys(Manga.rawAttributes).filter(field => !['id', 'createdAt', 'updatedAt'].includes(field) && saved[field] !== undefined)
  const metadataFields = Object.keys(Metadata.rawAttributes).filter(field => !['hash', 'createdAt', 'updatedAt'].includes(field) && saved[field] !== undefined)
  const values = fields => fields.map(field => columnValue(field, saved[field]))
  let transactionOpen = false
  try {
    await database.exec('PRAGMA busy_timeout = 5000')
    await database.run('ATTACH DATABASE ? AS book_metadata', [Metadata.sequelize.options.storage])
    await database.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    const update = await database.run(
      `UPDATE "${mangaTable}" SET ${fields.map(field => `"${field}" = ?`).join(', ')}, "updatedAt" = ? WHERE "id" = ?`,
      [...values(fields), timestamp, saved.id]
    )
    if (update.changes !== 1) throw new Error('书籍记录不存在，保存未执行')
    const insert = ['hash', ...metadataFields, 'createdAt', 'updatedAt']
    await database.run(
      `INSERT INTO book_metadata."${metadataTable}" (${insert.map(field => `"${field}"`).join(', ')})
       VALUES (${insert.map(() => '?').join(', ')})
       ON CONFLICT("hash") DO UPDATE SET ${[...metadataFields, 'updatedAt'].map(field => `"${field}" = excluded."${field}"`).join(', ')}`,
      [saved.hash, ...values(metadataFields), timestamp, timestamp]
    )
    await database.exec('COMMIT')
    transactionOpen = false
    return { ...saved, updatedAt: now.toISOString() }
  } finally {
    if (transactionOpen) await database.exec('ROLLBACK').catch(() => {})
    await database.close()
  }
}

module.exports = { mergeBookEdits, withBookAuthors, writeBookEdit }
