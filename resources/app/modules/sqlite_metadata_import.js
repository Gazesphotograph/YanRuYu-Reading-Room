'use strict'

const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')

const TAG_COLUMNS = ['language', 'parody', 'character', 'group', 'artist', 'male', 'female', 'mixed', 'other', 'cosplayer', 'rest']
const METADATA_FIELDS = ['title', 'title_jpn', 'status', 'tags', 'filecount', 'rating', 'posted', 'filesize', 'category', 'url']

function quoteIdentifier(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error('数据库表名无效')
  return '"' + name + '"'
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&')
}

// Old datasets use Python-style quoted lists. Parse their string grammar without eval,
// preserving apostrophes in names instead of replacing every quote in the payload.
function parseLegacyStringList(text) {
  let index = 0
  const skip = () => { while (/\s/.test(text[index] || '') && index < text.length) index++ }
  const invalid = () => { throw new Error('标签必须是 JSON 或旧版字符串数组') }
  skip()
  if (text[index++] !== '[') invalid()
  const values = []
  while (true) {
    skip()
    if (text[index] === ']') { index++; break }
    if (text[index] === 'u' && /['"]/.test(text[index + 1] || '')) index++
    const quote = text[index++]
    if (quote !== "'" && quote !== '"') invalid()
    let value = '', closed = false
    while (index < text.length) {
      const char = text[index++]
      if (char === quote) { closed = true; break }
      if (char !== '\\') { value += char; continue }
      if (index >= text.length) invalid()
      const escaped = text[index++]
      if (escaped === 'u' || escaped === 'x') {
        const length = escaped === 'u' ? 4 : 2
        const code = text.slice(index, index + length)
        if (!new RegExp('^[a-fA-F0-9]{' + length + '}$').test(code)) invalid()
        value += String.fromCharCode(parseInt(code, 16))
        index += length
      } else {
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' }
        value += Object.hasOwn(escapes, escaped) ? escapes[escaped] : escaped
      }
    }
    if (!closed) invalid()
    values.push(value)
    skip()
    if (text[index] === ']') { index++; break }
    if (text[index++] !== ',') invalid()
  }
  skip()
  if (index !== text.length) invalid()
  return values
}

function parseTagList(value, column) {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 1024 * 1024) throw new Error(`${column} 标签格式无效`)
  let list
  try { list = JSON.parse(value) } catch {
    try { list = parseLegacyStringList(value) } catch (error) {
      throw new Error(`${column} 标签格式无效：${error.message}`)
    }
  }
  if (!Array.isArray(list) || list.length > 10000 || list.some(tag => typeof tag !== 'string')) {
    throw new Error(`${column} 标签必须是字符串数组`)
  }
  return list
}

function normalizeMetadata(row, sourceColumns) {
  const gid = Number(row.gid)
  const token = String(row.token || '')
  if (!Number.isSafeInteger(gid) || gid <= 0 || !/^[a-f0-9]{10}$/i.test(token)) throw new Error('画廊 gid 或 token 格式无效')
  if (typeof row.title !== 'string' || !row.title.trim()) throw new Error('画廊标题为空或格式无效')
  const metadata = { title: row.title, status: 'tagged', url: `https://exhentai.org/g/${gid}/${token}/` }
  for (const column of ['title_jpn', 'category']) {
    if (sourceColumns.has(column) && row[column] != null) {
      if (typeof row[column] !== 'string') throw new Error(`${column} 必须是文本`)
      metadata[column] = row[column]
    }
  }
  const tags = {}
  for (const column of TAG_COLUMNS) {
    if (!sourceColumns.has(column)) continue
    const values = parseTagList(row[column], column)
    if (values !== undefined) tags[column] = values
  }
  if (TAG_COLUMNS.some(column => sourceColumns.has(column))) metadata.tags = tags
  for (const column of ['filecount', 'rating', 'posted', 'filesize']) {
    if (!sourceColumns.has(column) || row[column] == null || row[column] === '') continue
    const value = Number(row[column])
    if (!Number.isFinite(value) || value < 0 || (column !== 'rating' && !Number.isSafeInteger(value)) || (column === 'rating' && value > 5)) {
      throw new Error(`${column} 数值无效`)
    }
    metadata[column] = value
  }
  return metadata
}

async function preflightSource(filename) {
  const stat = await fs.promises.stat(filename)
  if (!stat.isFile() || stat.size < 16) throw new Error('所选文件不是有效的 SQLite 数据库')
  const handle = await fs.promises.open(filename, 'r')
  try {
    const header = Buffer.alloc(16)
    await handle.read(header, 0, 16, 0)
    if (header.toString('binary') !== 'SQLite format 3\u0000') throw new Error('所选文件不是有效的 SQLite 数据库')
  } finally { await handle.close() }
  const db = await open({ filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY })
  try {
    await db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000')
    const check = await db.get('PRAGMA quick_check(1)')
    if (!check || Object.values(check)[0] !== 'ok') throw new Error('SQLite 完整性检查失败：' + (check ? Object.values(check)[0] : '没有检查结果'))
    const table = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", ['gallery'])
    if (!table) throw new Error('SQLite 文件缺少 gallery 表')
    const columns = new Set((await db.all('PRAGMA table_info("gallery")')).map(column => column.name))
    const missing = ['gid', 'token', 'title'].filter(column => !columns.has(column))
    if (missing.length) throw new Error('gallery 表缺少必要字段：' + missing.join(', '))
    return { db, columns }
  } catch (error) {
    await db.close().catch(() => {})
    throw error
  }
}

function filenameForBook(book) {
  const basename = path.basename(book.filepath || '')
  if (basename) return book.type === 'folder' ? basename : basename.replace(/\.(zip|cbz|rar|cbr|7z|cb7)$/i, '')
  return typeof book.title === 'string' ? book.title.trim() : ''
}

async function findSourceMetadata(db, columns, book, getEhviewerData) {
  if (book.type === 'folder' && getEhviewerData) {
    const hint = await getEhviewerData(book.filepath)
    if (hint?.gid && hint?.token) {
      const rows = await db.all('SELECT * FROM gallery WHERE gid = ? AND token = ? LIMIT 2', [hint.gid, hint.token])
      if (rows.length) return rows
    }
  }
  const filename = filenameForBook(book).trim()
  if (filename) {
    const fields = ['title', 'title_jpn'].filter(column => columns.has(column))
    const rows = await db.all('SELECT * FROM gallery WHERE ' + fields.map(field => quoteIdentifier(field) + ' = ?').join(' OR ') + ' LIMIT 2', fields.map(() => filename))
    if (rows.length) return rows
  }
  const clauses = [], parameters = []
  if (filename) {
    for (const field of ['torrents', 'title', 'title_jpn'].filter(column => columns.has(column))) {
      clauses.push(quoteIdentifier(field) + " LIKE ? ESCAPE '\\'")
      parameters.push('%' + escapeLike(filename) + '%')
    }
  }
  if (typeof book.coverHash === 'string' && /^[a-f0-9]{20,128}$/i.test(book.coverHash) && columns.has('thumb')) {
    clauses.push("thumb LIKE ? ESCAPE '\\'")
    parameters.push('%' + escapeLike(book.coverHash) + '%')
  }
  return clauses.length ? db.all('SELECT * FROM gallery WHERE ' + clauses.join(' OR ') + ' LIMIT 2', parameters) : []
}

function tableName(model) {
  const name = model.getTableName()
  return quoteIdentifier(typeof name === 'string' ? name : name.tableName)
}

function resultMessage(counts, error) {
  const title = error || counts.failed ? (counts.imported ? '部分导入完成' : '导入失败') : '导入完成'
  return `${title}：成功 ${counts.imported}，失败 ${counts.failed}，未匹配 ${counts.unmatched}，跳过 ${counts.skipped}。${error ? ' 原因：' + error : ''}`
}

async function importSqliteMetadata({ filename, books, Manga, Metadata, getEhviewerData, onProgress }) {
  const validInput = Array.isArray(books)
  const bList = validInput ? books.map(book => ({ ...book })) : []
  const counts = { total: bList.length, eligible: bList.filter(book => book.status !== 'tagged').length, matched: 0, imported: 0, failed: 0, unmatched: 0, skipped: bList.filter(book => book.status === 'tagged').length }
  const failures = [], unmatched = [], plans = [], seen = new Set()
  let source, target, fatalError, transactionOpen = false
  const reportProgress = value => { try { onProgress?.(value) } catch {} }
  const failure = (book, reason) => {
    counts.failed++
    failures.push({ id: book?.id || null, title: book?.title || '', reason })
  }
  try {
    if (!validInput) throw new Error('导入书目列表格式无效')
    source = await preflightSource(filename)
    const mangaPath = Manga.sequelize.options.storage
    const metadataPath = Metadata.sequelize.options.storage
    const [mainRealPath, metadataRealPath, sourceRealPath] = await Promise.all([mangaPath, metadataPath, filename].map(file => fs.promises.realpath(file)))
    if (mainRealPath === metadataRealPath || [mainRealPath, metadataRealPath].includes(sourceRealPath)) throw new Error('导入来源、主书库和元数据数据库必须是不同文件')
    target = await open({ filename: mangaPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READWRITE })
    await target.exec('PRAGMA busy_timeout = 5000')
    // One connection and one attached transaction keep the two databases in step on failure.
    await target.run('ATTACH DATABASE ? AS metadata_import', [metadataPath])
    const mangaTable = tableName(Manga), metadataTable = tableName(Metadata)
    const mainColumns = new Set((await target.all(`PRAGMA main.table_info(${mangaTable})`)).map(column => column.name))
    const metadataColumns = new Set((await target.all(`PRAGMA metadata_import.table_info(${metadataTable})`)).map(column => column.name))
    for (const field of ['id', 'hash', ...METADATA_FIELDS, 'updatedAt']) {
      if (!mainColumns.has(field)) throw new Error('主书库缺少必要字段：' + field)
    }
    for (const field of ['hash', ...METADATA_FIELDS, 'createdAt', 'updatedAt']) {
      if (!metadataColumns.has(field)) throw new Error('元数据数据库缺少必要字段：' + field)
    }
    for (let index = 0; index < bList.length; index++) {
      const selected = bList[index]
      reportProgress(bList.length ? index / bList.length : 1)
      if (selected.status === 'tagged') continue
      if (typeof selected.id !== 'string' || !selected.id) { failure(selected, '书目缺少有效 ID'); continue }
      if (seen.has(selected.id)) { counts.skipped++; counts.eligible--; continue }
      seen.add(selected.id)
      const current = await target.get(`SELECT * FROM ${mangaTable} WHERE id = ?`, [selected.id])
      if (!current || !current.hash || (selected.hash && current.hash !== selected.hash)) { failure(selected, '书目已更改或不存在，请刷新书库后重试'); continue }
      if (current.status === 'tagged') { counts.skipped++; counts.eligible--; continue }
      let rows
      try { rows = await findSourceMetadata(source.db, source.columns, current, getEhviewerData) } catch (error) {
        failure(selected, '读取候选元数据失败：' + error.message)
        continue
      }
      if (!rows.length) {
        counts.unmatched++
        unmatched.push({ id: selected.id, title: selected.title || current.title || '', reason: '未找到匹配的画廊' })
        continue
      }
      if (rows.length > 1) { failure(selected, '匹配到多个画廊，已跳过以避免误写'); continue }
      counts.matched++
      try {
        plans.push({ index, current, metadata: normalizeMetadata(rows[0], source.columns) })
      } catch (error) {
        failure(selected, '元数据校验失败：' + error.message)
      }
    }
    if (plans.length) {
      await target.exec('BEGIN IMMEDIATE')
      transactionOpen = true
      for (const plan of plans) {
        const fields = Object.keys(plan.metadata).filter(field => METADATA_FIELDS.includes(field))
        const values = fields.map(field => field === 'tags' ? JSON.stringify(plan.metadata[field]) : plan.metadata[field])
        const now = new Date().toISOString()
        const unchanged = await target.get(`SELECT hash, updatedAt FROM ${mangaTable} WHERE id = ?`, [plan.current.id])
        if (!unchanged || unchanged.hash !== plan.current.hash || unchanged.updatedAt !== plan.current.updatedAt) {
          throw new Error(`书目“${plan.current.title}”在导入期间已更改，本次写入全部回滚`)
        }
        const update = await target.run(`UPDATE ${mangaTable} SET ${fields.map(field => quoteIdentifier(field) + ' = ?').join(', ')}, "updatedAt" = ? WHERE "id" = ? AND "hash" = ?`, [...values, now, plan.current.id, plan.current.hash])
        if (update.changes !== 1) throw new Error('书库写入数量与预期不符，本次写入全部回滚')
        const insertFields = ['hash', ...fields, 'createdAt', 'updatedAt']
        await target.run(`INSERT INTO metadata_import.${metadataTable} (${insertFields.map(quoteIdentifier).join(', ')}) VALUES (${insertFields.map(() => '?').join(', ')}) ON CONFLICT("hash") DO UPDATE SET ${[...fields, 'updatedAt'].map(field => quoteIdentifier(field) + ' = excluded.' + quoteIdentifier(field)).join(', ')}`, [plan.current.hash, ...values, now, now])
      }
      await target.exec('COMMIT')
      transactionOpen = false
      counts.imported = plans.length
      for (const plan of plans) bList[plan.index] = { ...bList[plan.index], ...plan.metadata }
    }
    reportProgress(1)
  } catch (error) {
    fatalError = error.message || String(error)
    if (transactionOpen && target) {
      try { await target.exec('ROLLBACK') } catch (rollbackError) {
        fatalError += '；回滚失败：' + rollbackError.message
      }
      transactionOpen = false
    }
    counts.failed += Math.max(0, counts.eligible - counts.imported - counts.failed - counts.unmatched)
    failures.push({ id: null, title: '', reason: fatalError })
  } finally {
    await source?.db.close().catch(() => {})
    await target?.close().catch(() => {})
    reportProgress(-1)
  }
  const firstError = fatalError || failures[0]?.reason
  return {
    success: !fatalError && counts.failed === 0,
    canceled: false,
    partial: counts.imported > 0 && counts.failed > 0,
    counts,
    failures,
    unmatched,
    message: resultMessage(counts, firstError),
    bList,
    bookList: bList,
  }
}

module.exports = { importSqliteMetadata, parseTagList, normalizeMetadata }
