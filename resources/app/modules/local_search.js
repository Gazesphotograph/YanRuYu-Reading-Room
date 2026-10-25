'use strict'

// The corpus is deliberately small and local: no model files, remote requests,
// metadata rewrites, or automatic image reads are part of this service.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { serialQueue } = require('./safety')
const { assertLocalPath } = require('./restore_transaction')
const { validBookId } = require('./reading_state')
const { getWindowsOcrCapability, recognizeWindowsImage } = require('./windows_ocr')

const LIMITS = Object.freeze({ aliases: 200, namesPerAlias: 20, nameLength: 120, pages: 500,
  charactersPerPage: 30000, bytesPerPage: 96 * 1024, textBytes: 8 * 1024 * 1024,
  termsPerPage: 1024, previewMinutes: 10, results: 100 })
const MAX_STATE_BYTES = 24 * 1024 * 1024
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value)
const clone = value => JSON.parse(JSON.stringify(value))
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
const titleOf = book => String(book.title_jpn || book.title || '未命名书籍')
const documentKey = (bookId, page) => `${bookId}\0${page}`
const compare = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare
const stopWords = new Set(['the', 'and', 'with', 'that', 'this', 'from', 'for', 'are', 'was', 'have', 'into', 'a', 'an', 'of', 'to', 'is', 'in', 'on', '的', '了', '着', '是', '和', '在', 'を', 'は', 'が', 'の', 'に'])

function bookTags(book) {
  let tags = book.tags
  if (typeof tags === 'string') { try { tags = JSON.parse(tags) } catch { tags = {} } }
  if (!isRecord(tags)) return []
  return Object.entries(tags).flatMap(([group, values]) => (Array.isArray(values) ? values : [values])
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => ({ group, value: String(value).trim() })).filter(tag => tag.value))
}

function aliasName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > LIMITS.nameLength || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`别名必须是 1–${LIMITS.nameLength} 个字符的名称`)
  }
  return value.trim()
}

function normalizeAlias(value, id = value?.id || randomUUID()) {
  if (!isRecord(value) || !['author', 'series'].includes(value.kind) || !validBookId(id)) throw new Error('别名规则格式无效')
  const canonical = aliasName(value.canonical)
  if (!Array.isArray(value.aliases) || value.aliases.length > LIMITS.namesPerAlias) throw new Error(`每组最多填写 ${LIMITS.namesPerAlias} 个别名`)
  const seen = new Set([normalize(canonical)])
  const aliases = value.aliases.map(aliasName).filter(name => {
    const key = normalize(name)
    if (seen.has(key)) return false
    seen.add(key); return true
  })
  if (!aliases.length) throw new Error('请填写至少一个与标准名称不同的别名')
  return { id, kind: value.kind, canonical, aliases }
}

function validateAliases(aliases) {
  if (!Array.isArray(aliases) || aliases.length > LIMITS.aliases) throw new Error(`最多保存 ${LIMITS.aliases} 组别名`)
  const owners = new Map(), ids = new Set()
  const result = aliases.map(rule => {
    if (!isRecord(rule) || !validBookId(rule.id)) throw new Error('别名规则 ID 无效')
    return normalizeAlias(rule, rule.id)
  })
  for (const rule of result) {
    if (ids.has(rule.id)) throw new Error('别名规则 ID 重复')
    ids.add(rule.id)
    for (const name of [rule.canonical, ...rule.aliases]) {
      const key = `${rule.kind}\0${normalize(name)}`
      if (owners.has(key)) throw new Error(`「${name}」已属于另一组${rule.kind === 'author' ? '作者' : '系列'}别名，请编辑原规则`)
      owners.set(key, rule.id)
    }
  }
  return result
}

function validateText(value) {
  if (!isRecord(value) || !validBookId(value.bookId) || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 1000000 ||
      typeof value.text !== 'string' || !value.text.trim() || value.text.length > LIMITS.charactersPerPage || Buffer.byteLength(value.text) > LIMITS.bytesPerPage || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isFinite(value.updatedAt) || value.updatedAt < 0 ||
      !['manual', 'windows-ocr'].includes(value.source) || (value.language !== undefined && (typeof value.language !== 'string' || !/^[a-zA-Z0-9-]{0,35}$/.test(value.language)))) {
    throw new Error(`文本页格式无效；每页最多 ${LIMITS.charactersPerPage} 字符、${LIMITS.bytesPerPage / 1024} KiB`)
  }
  return { bookId: value.bookId, page: value.page, text: value.text, revision: value.revision, updatedAt: value.updatedAt,
    source: value.source, language: value.language || '' }
}

function validateLocalSearchState(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.indexPaused !== 'boolean' || !Array.isArray(value.texts) || value.texts.length > LIMITS.pages) {
    throw new Error('本地检索档案格式无效，请保留 local-search.json 并从备份恢复')
  }
  const aliases = validateAliases(value.aliases), texts = value.texts.map(validateText), keys = new Set()
  let bytes = 0
  for (const entry of texts) {
    const key = documentKey(entry.bookId, entry.page)
    if (keys.has(key) || entry.revision > value.revision) throw new Error('文本页重复或版本无效')
    keys.add(key); bytes += Buffer.byteLength(entry.text)
  }
  if (bytes > LIMITS.textBytes) throw new Error('本地文本超过 8 MiB 的原型容量上限')
  return { schemaVersion: 1, revision: value.revision, aliases, texts, indexPaused: value.indexPaused }
}

function buildAliasMaps(aliases) {
  const maps = { author: new Map(), series: new Map() }
  for (const rule of aliases) for (const name of [rule.canonical, ...rule.aliases]) maps[rule.kind].set(normalize(name), rule)
  return maps
}

function bookMetadata(book, maps) {
  const tags = bookTags(book)
  const authors = [...tags.filter(tag => tag.group === 'artist').map(tag => tag.value), ...(typeof book.author === 'string' ? [book.author] : [])]
  const series = [...tags.filter(tag => ['parody', 'series'].includes(tag.group)).map(tag => tag.value), ...(typeof book.series === 'string' ? [book.series] : [])]
  const rules = new Map()
  for (const [kind, names] of [['author', authors], ['series', series]]) {
    for (const name of names) { const rule = maps[kind].get(normalize(name)); if (rule) rules.set(rule.id, rule) }
  }
  const canonical = (kind, names) => new Map(names.map(name => {
    const value = maps[kind].get(normalize(name))?.canonical || name
    return [normalize(value), value]
  }))
  return { tags, authors: canonical('author', authors), series: canonical('series', series), rules: [...rules.values()],
    title: normalize([book.title_jpn, book.title].filter(Boolean).join(' ')),
    raw: normalize([titleOf(book), book.title, book.category, ...tags.map(tag => tag.value), ...authors, ...series].join(' ')),
    expanded: normalize([...rules.values()].flatMap(rule => [rule.canonical, ...rule.aliases]).join(' ')) }
}

// CJK unigrams and bigrams keep Japanese/Chinese text useful without bundling a
// dictionary. This is lexical retrieval, explicitly not a neural embedding.
function tokenize(value, maximum = LIMITS.termsPerPage) {
  const frequencies = new Map()
  let count = 0, truncated = false
  function add(token) {
    if (!token || stopWords.has(token)) return
    if (!frequencies.has(token) && frequencies.size >= maximum) { truncated = true; return }
    frequencies.set(token, (frequencies.get(token) || 0) + 1); count++
  }
  const runs = normalize(value).match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}]+/gu) || []
  for (const run of runs) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(run)) {
      const characters = [...run]
      for (let index = 0; index < characters.length; index++) {
        add(characters[index])
        if (index + 1 < characters.length) add(characters[index] + characters[index + 1])
      }
    } else add(run)
  }
  return { frequencies, count, truncated }
}

function snippet(text, query, terms) {
  const normalized = normalize(text), exact = normalized.indexOf(normalize(query))
  let offset = exact >= 0 ? exact : terms.reduce((first, term) => {
    const found = normalized.indexOf(term)
    return found < 0 ? first : Math.min(first, found)
  }, text.length)
  if (offset === text.length) offset = 0
  const start = Math.max(0, offset - 40), end = Math.min(text.length, start + 180)
  return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
}

async function writeAtomic(storePath, state) {
  const target = assertLocalPath(storePath, path.join(storePath, 'local-search.json'))
  const temporary = assertLocalPath(storePath, `${target}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await fs.promises.open(temporary, 'wx')
    await handle.writeFile(JSON.stringify(state), 'utf8')
    await handle.sync(); await handle.close(); handle = null
    assertLocalPath(storePath, target)
    await fs.promises.rename(temporary, target)
  } finally {
    if (handle) await handle.close()
    await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

class LocalSearchService {
  constructor({ storePath, getBooks, onChange = null, now = Date.now, ocr = {} }) {
    if (typeof getBooks !== 'function' || typeof storePath !== 'string' || !path.isAbsolute(storePath)) throw new Error('本地检索需要有效的数据目录和书库接口')
    this.storePath = path.resolve(storePath); this.getBooks = getBooks; this.onChange = onChange; this.now = now
    this.ocrCapability = ocr.capability || getWindowsOcrCapability; this.ocrRecognize = ocr.recognize || recognizeWindowsImage
    this.queue = serialQueue(); this.previews = new Map(); this.index = new Map(); this.scheduled = null
    this.buildMilliseconds = 0; this.initialError = null
    this.state = { schemaVersion: 1, revision: 0, aliases: [], texts: [], indexPaused: false }
    this.ready = this.load().catch(error => { this.initialError = error })
  }
  async load() {
    const target = assertLocalPath(this.storePath, path.join(this.storePath, 'local-search.json'))
    try {
      const stat = await fs.promises.lstat(target)
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error('本地检索档案过大或不是普通文件')
      this.state = validateLocalSearchState(JSON.parse(await fs.promises.readFile(target, 'utf8')))
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    this.schedule()
  }
  async checkReady() { await this.ready; if (this.initialError) throw this.initialError }
  async books() {
    const records = await this.getBooks()
    if (!Array.isArray(records)) throw new Error('暂时无法读取书库')
    return records.filter(book => isRecord(book) && validBookId(book.id) && !book.hiddenBook)
  }
  notify() { if (typeof this.onChange !== 'function') return; try { this.onChange(this.status()) } catch { /* UI notifications must not undo a durable save. */ } }
  pending() { return this.state.texts.filter(entry => this.index.get(documentKey(entry.bookId, entry.page))?.revision !== entry.revision) }
  schedule() {
    if (this.state.indexPaused || this.scheduled || !this.pending().length) return
    this.scheduled = setImmediate(() => {
      this.scheduled = null
      if (this.state.indexPaused) return
      const started = performance.now()
      for (const entry of this.pending().slice(0, 2)) {
        const indexed = tokenize(entry.text)
        this.index.set(documentKey(entry.bookId, entry.page), { ...indexed, revision: entry.revision,
          bookId: entry.bookId, page: entry.page, text: entry.text })
      }
      this.buildMilliseconds += performance.now() - started
      this.notify(); this.schedule()
    })
  }
  status() {
    const textBytes = this.state.texts.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0)
    let terms = 0, termBytes = 0, truncatedPages = 0
    for (const entry of this.index.values()) {
      terms += entry.frequencies.size; if (entry.truncated) truncatedPages++
      for (const term of entry.frequencies.keys()) termBytes += term.length * 2
    }
    return { revision: this.state.revision, aliases: clone(this.state.aliases), paused: this.state.indexPaused,
      savedPages: this.state.texts.length, indexedPages: this.index.size, pendingPages: this.pending().length,
      textBytes, fileBytes: Buffer.byteLength(JSON.stringify(this.state)), estimatedIndexBytes: termBytes + terms * 64,
      indexedTerms: terms, truncatedPages, buildMilliseconds: Math.round(this.buildMilliseconds), modelBytes: 0,
      remoteRequests: 0, limits: LIMITS,
      capabilities: { metadataAliases: true, explainableRecommendations: true, localKeywordSearch: true, neuralSemanticSearch: false,
        automaticLibraryOcr: false, ocr: 'optional-windows-system' },
      texts: this.state.texts.map(({ bookId, page, updatedAt, revision, source, language, text }) =>
        ({ bookId, page, updatedAt, revision, source, language, characters: text.length })) }
  }
  async snapshot() { await this.checkReady(); return this.status() }
  async persist(next) {
    const normalized = validateLocalSearchState({ ...next, revision: this.state.revision + 1 })
    await writeAtomic(this.storePath, normalized); this.state = normalized; this.notify()
  }
  preview(value) {
    for (const [token, preview] of this.previews) if (preview.expiresAt <= this.now()) this.previews.delete(token)
    while (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value)
    const token = randomUUID()
    this.previews.set(token, { ...value, revision: this.state.revision, expiresAt: this.now() + LIMITS.previewMinutes * 60000 })
    return token
  }
  getPreview(token, kind) {
    const preview = typeof token === 'string' ? this.previews.get(token) : null
    if (!preview || preview.kind !== kind || preview.expiresAt <= this.now() || preview.revision !== this.state.revision) throw new Error('预览已过期或内容已变化，请重新预览后确认')
    return preview
  }
  async previewAlias(payload) {
    const deleting = payload.operation === 'delete'
    const old = payload.id ? this.state.aliases.find(rule => rule.id === payload.id) : null
    if ((deleting || payload.id) && !old) throw new Error('原别名规则已不存在，请刷新后重试')
    const alias = deleting ? old : normalizeAlias(payload, old?.id || randomUUID())
    const next = validateAliases([...this.state.aliases.filter(rule => rule.id !== alias.id), ...(deleting ? [] : [alias])])
    const names = new Set([alias.canonical, ...alias.aliases, ...(old ? [old.canonical, ...old.aliases] : [])].map(normalize))
    const books = await this.books()
    const affected = books.filter(book => {
      const metadata = bookMetadata(book, buildAliasMaps([]))
      return [...metadata[alias.kind === 'author' ? 'authors' : 'series'].keys()].some(name => names.has(name))
    })
    const token = this.preview({ kind: 'alias', next })
    return { token, operation: deleting ? 'delete' : old ? 'update' : 'create', alias, affectedCount: affected.length,
      affectedBooks: affected.slice(0, 12).map(book => ({ bookId: book.id, title: titleOf(book) })), metadataUnchanged: true }
  }
  async previewText(payload) {
    const book = (await this.books()).find(book => book.id === payload.bookId)
    if (!book) throw new Error('书籍已不存在或已隐藏，请重新选择')
    const entry = validateText({ bookId: payload.bookId, page: payload.page, text: payload.text,
      source: payload.source || 'manual', language: payload.language || '', revision: this.state.revision + 1, updatedAt: this.now() })
    const pageCount = Number(book.pageCount || book.filecount)
    if (Number.isSafeInteger(pageCount) && pageCount > 0 && entry.page > pageCount) throw new Error(`此书只有 ${pageCount} 页，请检查页码`)
    const previous = this.state.texts.find(item => documentKey(item.bookId, item.page) === documentKey(entry.bookId, entry.page))
    const next = [...this.state.texts.filter(item => documentKey(item.bookId, item.page) !== documentKey(entry.bookId, entry.page)), entry]
    validateLocalSearchState({ ...this.state, revision: this.state.revision + 1, texts: next })
    const token = this.preview({ kind: 'text', next, entry })
    return { token, bookId: book.id, title: titleOf(book), page: entry.page, replacesExisting: !!previous,
      previousCharacters: previous?.text.length || 0, characters: entry.text.length, bytes: Buffer.byteLength(entry.text), source: entry.source }
  }
  async search(payload) {
    const query = typeof payload.query === 'string' ? payload.query.trim() : ''
    if (!query || query.length > 500) throw new Error('请填写 1–500 字符的检索内容')
    const mode = ['all', 'metadata', 'text'].includes(payload.mode) ? payload.mode : 'all'
    const limit = Number.isSafeInteger(payload.limit) ? Math.max(1, Math.min(LIMITS.results, payload.limit)) : 30
    const books = await this.books(), byId = new Map(books.map(book => [book.id, book])), maps = buildAliasMaps(this.state.aliases)
    const normalized = normalize(query), words = normalized.split(' ').filter(Boolean), results = new Map()
    if (mode !== 'text') for (const book of books) {
      const metadata = bookMetadata(book, maps), haystack = `${metadata.raw} ${metadata.expanded}`
      if (!words.every(word => haystack.includes(word))) continue
      const reasons = []
      if (words.every(word => metadata.title.includes(word))) reasons.push('书名包含检索词')
      for (const rule of metadata.rules) {
        if ([rule.canonical, ...rule.aliases].some(name => words.some(word => normalize(name).includes(word)))) {
          reasons.push(`${rule.kind === 'author' ? '作者' : '系列'}别名：${rule.canonical} ↔ ${rule.aliases.join('、')}`)
        }
      }
      if (!reasons.length) reasons.push('作者、系列或标签包含检索词')
      results.set(book.id, { bookId: book.id, title: titleOf(book), score: reasons[0] === '书名包含检索词' ? 100 : 75,
        reasons, source: 'metadata', matches: [], missing: book.exist === false })
    }
    if (mode !== 'metadata') {
      const terms = [...tokenize(query, 80).frequencies.keys()]
      const documents = [...this.index.values()].filter(entry => byId.has(entry.bookId))
      const average = documents.reduce((sum, entry) => sum + entry.count, 0) / Math.max(1, documents.length)
      const idf = new Map(terms.map(term => {
        const df = documents.filter(entry => entry.frequencies.has(term)).length
        return [term, Math.log(1 + (documents.length - df + .5) / (df + .5))]
      }))
      for (const entry of documents) {
        const matched = terms.filter(term => entry.frequencies.has(term)), exact = normalize(entry.text).includes(normalized)
        // At least half the query's meaningful terms must match; common single
        // characters alone must not turn an unrelated page into a strong hit.
        if (!matched.length || (!exact && matched.length / Math.max(1, terms.length) < .5)) continue
        let score = 0
        for (const term of matched) {
          const tf = entry.frequencies.get(term), weight = [...term].length > 1 ? 1 : .3
          score += weight * idf.get(term) * tf * 2.2 / (tf + 1.2 * (.25 + .75 * entry.count / Math.max(1, average)))
        }
        score = Math.round((score + (exact ? 5 : 0)) * 100) / 100
        const book = byId.get(entry.bookId), match = { page: entry.page, score, snippet: snippet(entry.text, query, matched), terms: matched.filter(term => [...term].length > 1).slice(0, 8) }
        const existing = results.get(entry.bookId)
        if (existing) { existing.matches.push(match); if (!existing.reasons.includes('已导入的本地文本匹配')) existing.reasons.push('已导入的本地文本匹配'); existing.source = existing.source === 'metadata' ? 'metadata+text' : 'text'; existing.score = Math.max(existing.score, score) }
        else results.set(book.id, { bookId: book.id, title: titleOf(book), score, reasons: [exact ? '本地文本包含完整检索词' : '本地文本关键词相近'], source: 'text', matches: [match], missing: book.exist === false })
      }
    }
    const ordered = [...results.values()].sort((a, b) => b.score - a.score || compare(a.title, b.title))
    for (const result of ordered) { result.matches.sort((a, b) => b.score - a.score); result.matches = result.matches.slice(0, 3); result.page = result.matches[0]?.page || null }
    return { query, mode, total: ordered.length, results: ordered.slice(0, limit), paused: this.state.indexPaused,
      indexedPages: this.index.size, pendingPages: this.pending().length, method: '本地元数据、别名与 BM25 关键词检索；未使用神经语义模型' }
  }
  async recommend(payload) {
    if (!validBookId(payload.bookId)) throw new Error('书籍 ID 无效')
    const books = await this.books(), book = books.find(book => book.id === payload.bookId)
    if (!book) throw new Error('书籍已不存在或已隐藏')
    const maps = buildAliasMaps(this.state.aliases), seed = bookMetadata(book, maps), matches = []
    const otherTags = metadata => new Map(metadata.tags.filter(tag => !['artist', 'parody', 'series', 'language', 'reclass'].includes(tag.group))
      .map(tag => [`${normalize(tag.group)}\0${normalize(tag.value)}`, tag.value]))
    const seedTags = otherTags(seed)
    for (const candidate of books) {
      if (candidate.id === book.id || candidate.exist === false) continue
      const metadata = bookMetadata(candidate, maps), reasons = [], terms = []
      let score = 0
      for (const [key, label] of seed.authors) if (metadata.authors.has(key)) { score += 8; reasons.push(`同一作者：${label}`) }
      for (const [key, label] of seed.series) if (metadata.series.has(key)) { score += 7; reasons.push(`同一系列：${label}`) }
      const candidateTags = otherTags(metadata)
      for (const [key, label] of seedTags) if (candidateTags.has(key)) terms.push(label)
      if (terms.length) { score += Math.min(8, terms.length * 2); reasons.push(`共同标签：${terms.slice(0, 5).join('、')}`) }
      // A category alone is too broad to justify a recommendation.
      if (score && book.category && normalize(book.category) === normalize(candidate.category)) { score += 1; reasons.push(`相同分类：${book.category}`) }
      if (score) matches.push({ bookId: candidate.id, title: titleOf(candidate), score, reasons })
    }
    matches.sort((a, b) => b.score - a.score || compare(a.title, b.title))
    const limit = Number.isSafeInteger(payload.limit) ? Math.max(1, Math.min(30, payload.limit)) : 12
    return { bookId: book.id, title: titleOf(book), total: matches.length, results: matches.slice(0, limit),
      method: '本地作者、系列和标签的共同点；分数仅用于排序，不代表阅读偏好概率' }
  }
  async command(payload = {}) {
    if (!isRecord(payload) || typeof payload.action !== 'string') throw new Error('本地检索操作无效')
    if (payload.action === 'ocr-capability') return this.ocrCapability()
    await this.checkReady()
    if (payload.action === 'status') return this.status()
    if (payload.action === 'search') return this.search(payload)
    if (payload.action === 'recommend') return this.recommend(payload)
    if (payload.action === 'get-text') {
      if (!(await this.books()).some(book => book.id === payload.bookId)) throw new Error('书籍已不存在或已隐藏')
      const entry = this.state.texts.find(item => item.bookId === payload.bookId && item.page === payload.page)
      return entry ? clone(entry) : null
    }
    return this.queue(async () => {
      await this.checkReady()
      if (payload.action === 'preview-alias') return this.previewAlias(payload)
      if (payload.action === 'save-alias') {
        const preview = this.getPreview(payload.token, 'alias')
        await this.persist({ ...this.state, aliases: preview.next }); this.previews.delete(payload.token)
      } else if (payload.action === 'preview-text') return this.previewText(payload)
      else if (payload.action === 'save-text') {
        const preview = this.getPreview(payload.token, 'text')
        if (!(await this.books()).some(book => book.id === preview.entry.bookId)) throw new Error('书籍已不存在或已隐藏，请重新选择')
        await this.persist({ ...this.state, texts: preview.next }); this.previews.delete(payload.token)
        this.index.delete(documentKey(preview.entry.bookId, preview.entry.page)); this.schedule()
      } else if (['pause', 'resume', 'clear-index'].includes(payload.action)) {
        await this.persist({ ...this.state, indexPaused: payload.action !== 'resume' })
        if (payload.action === 'clear-index') { this.index.clear(); this.buildMilliseconds = 0 }
        if (this.state.indexPaused && this.scheduled) { clearImmediate(this.scheduled); this.scheduled = null }
        this.schedule()
      } else if (payload.action === 'clear-texts') {
        if (payload.confirmation !== '清除全部导入文本') throw new Error('请先确认清除范围')
        await this.persist({ ...this.state, texts: [] }); this.index.clear(); this.buildMilliseconds = 0
      } else if (payload.action === 'remove-text') {
        const entry = this.state.texts.find(item => item.bookId === payload.bookId && item.page === payload.page)
        if (!entry || entry.revision !== payload.revision) throw new Error('文本页已变化，请刷新后重新选择')
        await this.persist({ ...this.state, texts: this.state.texts.filter(item => item !== entry) }); this.index.delete(documentKey(entry.bookId, entry.page))
      } else throw new Error('不支持的本地检索操作')
      return this.status()
    })
  }
  async recognizeImage(filepath, options = {}) { return this.ocrRecognize(filepath, options) }
  async flush() { await this.checkReady(); await this.queue(async () => {}) }
  async waitForIdle() {
    await this.flush()
    while (this.scheduled) await new Promise(resolve => setImmediate(resolve))
    return this.status()
  }
  async dispose() {
    await this.flush()
    if (this.scheduled) clearImmediate(this.scheduled)
    this.scheduled = null; this.previews.clear()
  }
}

module.exports = { createLocalSearchService: options => new LocalSearchService(options), LocalSearchService,
  validateLocalSearchState, validateAliases, normalizeAlias, normalize, tokenize, LIMITS }
