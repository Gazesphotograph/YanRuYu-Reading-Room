'use strict'

const fs = require('fs/promises')
const path = require('path')
const { randomUUID } = require('crypto')
const fetch = require('node-fetch')
const { HttpsProxyAgent } = require('https-proxy-agent')
const { webURL, assertWithin, serialQueue } = require('./safety')
const { validBookId } = require('./reading_state')
const { checkCancelled } = require('./source_signature')
const he = require('./vendor/he')

const SOURCE_HOSTS = ['e-hentai.org', 'exhentai.org', 'api.e-hentai.org', 'hentag.com']
const SOURCE_TYPES = ['e-hentai', 'exhentai', 'e-search', 'exsearch', 'hentag', '.ehviewer']
const FIELDS = ['title', 'title_jpn', 'tags', 'category', 'rating', 'posted', 'filecount', 'filesize', 'url']
const CATEGORIES = ['Doujinshi', 'Manga', 'Artist CG', 'Game CG', 'Western', 'Non-H', 'Image Set', 'Cosplay', 'Asian Porn', 'Misc']
const PREVIEW_TTL = 10 * 60 * 1000
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const copy = value => JSON.parse(JSON.stringify(value))
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
class SourceUnavailableError extends Error {}

function decodeText(value) {
  return he.decode(String(value ?? ''))
}

function galleryURL(value) {
  const url = new URL(webURL(value, SOURCE_HOSTS))
  const gallery = /^\/g\/([1-9]\d*)\/([a-z0-9]{5,80})\/?$/i.exec(url.pathname)
  if (['e-hentai.org', 'exhentai.org'].includes(url.hostname) && gallery && Number.isSafeInteger(Number(gallery[1]))) {
    return { url: `${url.origin}/g/${gallery[1]}/${gallery[2]}/`, gid: Number(gallery[1]), token: gallery[2], type: 'e-hentai' }
  }
  const vault = /^\/vault\/([a-z0-9_-]{1,100})\/?$/i.exec(url.pathname)
  if (url.hostname === 'hentag.com' && vault) return { url: `${url.origin}/vault/${vault[1]}`, id: vault[1], type: 'hentag' }
  throw new Error('请填写 E-Hentai、ExHentai 的画廊链接，或 Hentag 的作品链接')
}

function sourceCookie(setting) {
  return ['ipb_member_id', 'ipb_pass_hash', 'igneous', 'star'].flatMap(key => setting[key] ? [`${key}=${setting[key]}`] : []).join('; ')
}

function validateSourceSettings(previous, patch) {
  if (!plain(patch) || Object.keys(patch).some(key => !['proxy', 'defaultScraper', 'requireGap', 'ipb_member_id', 'ipb_pass_hash', 'igneous', 'star'].includes(key))) throw new Error('元数据来源设置无效')
  const next = { ...previous }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'requireGap') {
      if (!Number.isSafeInteger(value) || value < 0 || value > 60000) throw new Error('请求间隔必须在 0 到 60000 毫秒之间')
    } else if (typeof value !== 'string' || value.length > 4096 || /[\r\n\x00]/.test(value)) throw new Error('元数据来源设置包含无效文本')
    if (key === 'defaultScraper' && !SOURCE_TYPES.includes(value)) throw new Error('不支持的元数据来源')
    if (key === 'proxy' && value) {
      let proxy
      try { proxy = new URL(value.includes('://') ? value : 'http://' + value) } catch { throw new Error('代理地址无效') }
      if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname) throw new Error('代理需要 HTTP 或 HTTPS 地址')
    }
    if (['ipb_member_id', 'ipb_pass_hash', 'igneous', 'star'].includes(key) && /[;\s]/.test(value)) throw new Error('登录 Cookie 需要分别填写其值')
    next[key] = value
  }
  return next
}

async function requestSource(value, { method = 'GET', data, cookie = '', proxy = '', signal, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const url = webURL(value, SOURCE_HOSTS)
  if (typeof cookie !== 'string' || /[\r\n\x00]/.test(cookie) || cookie.length > 16384) throw new Error('登录 Cookie 格式无效')
  const controller = new AbortController()
  const cancel = () => controller.abort()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) controller.abort()
  try {
    const headers = { Accept: 'application/json, text/html;q=0.9', 'User-Agent': 'Yanruyu/2.0' }
    // Login credentials never accompany Hentag or the public metadata API.
    if (cookie && ['e-hentai.org', 'exhentai.org'].includes(new URL(url).hostname)) headers.Cookie = cookie
    if (data !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetchImpl(url, { method, headers, signal: controller.signal, size: 16 * 1024 * 1024, redirect: 'error',
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      ...(proxy ? { agent: new HttpsProxyAgent(proxy.includes('://') ? proxy : 'http://' + proxy) } : {}) })
    if ([401, 403].includes(response.status) && new URL(url).hostname === 'exhentai.org') {
      throw new SourceUnavailableError(`ExHentai 拒绝访问（HTTP ${response.status}），请核对账号访问权限和元数据来源设置中的登录 Cookie`)
    }
    if (!response.ok) {
      const Failure = [401, 403, 429].includes(response.status) || response.status >= 500 ? SourceUnavailableError : Error
      throw new Failure(`元数据来源返回 HTTP ${response.status}，请检查来源、网络或登录设置`)
    }
    if (/^image\//i.test(response.headers?.get?.('content-type') || '')) throw new SourceUnavailableError('元数据来源返回了图片，请检查登录 Cookie 后重试')
    const text = await response.text()
    if (!text.trim()) throw new SourceUnavailableError('元数据来源返回空内容，请检查登录 Cookie 或稍后重试')
    if (/Your IP address has been|temporarily banned|exceeded.*(?:limit|quota)/i.test(text)) throw new SourceUnavailableError('元数据来源暂时限制了请求，请稍后重试并增大请求间隔')
    return text
  } catch (error) {
    if (controller.signal.aborted) {
      const cancelled = timedOut ? new SourceUnavailableError('元数据请求超时，请检查网络或代理后重试') : new Error('已取消元数据请求')
      cancelled.name = timedOut ? 'TimeoutError' : 'AbortError'
      throw cancelled
    }
    if (error.type || /^(FetchError|TypeError)$/.test(error.name)) throw new SourceUnavailableError('无法连接元数据来源，请检查网络或代理后重试')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

function jsonResponse(text) {
  try { return JSON.parse(text) } catch { throw new Error('元数据来源没有返回有效 JSON，请检查登录状态或稍后重试') }
}

function normalizeTags(value) {
  const tags = Object.create(null)
  const add = (group, raw) => {
    if (typeof raw !== 'string' || !raw.trim()) return
    if (!/^[a-z][a-z0-9_-]{0,59}$/i.test(group) || ['constructor', 'prototype', '__proto__'].includes(group)) group = 'misc'
    const name = decodeText(raw).trim()
    if (name.length > 600) throw new Error('来源标签过长，未应用元数据')
    const list = tags[group] ||= []
    if (!list.includes(name)) list.push(name)
  }
  if (Array.isArray(value)) for (const item of value) {
    if (typeof item !== 'string') continue
    const separator = item.indexOf(':')
    add(separator > 0 ? item.slice(0, separator) : 'misc', separator > 0 ? item.slice(separator + 1) : item)
  }
  else if (plain(value)) for (const [group, items] of Object.entries(value)) for (const item of Array.isArray(items) ? items : [items]) add(group, item)
  else if (value != null) throw new Error('来源标签格式无效')
  if (Object.values(tags).reduce((total, items) => total + items.length, 0) > 5000) throw new Error('来源标签数量过多')
  return tags
}

function normalizeMetadata(data, location) {
  let row, tags
  if (location.type === 'e-hentai') {
    row = data?.gmetadata?.[0]
    if (!plain(row) || row.error) throw new Error(row?.error ? '画廊元数据不可用：' + String(row.error).slice(0, 300) : '来源响应中没有画廊元数据')
    if ((row.gid !== undefined && Number(row.gid) !== location.gid) || (row.token !== undefined && row.token !== location.token)) throw new Error('来源返回的画廊与请求不一致，未应用元数据')
    tags = Object.hasOwn(row, 'tags') ? normalizeTags(row.tags) : undefined
  } else {
    if (!plain(data) || data.error || typeof data.title !== 'string') throw new Error('来源响应中没有作品元数据')
    const grouped = Object.create(null)
    for (const [field, group] of Object.entries({ parodies: 'parody', characters: 'character', circles: 'group', artists: 'artist', maleTags: 'male', femaleTags: 'female', otherTags: 'misc' })) {
      if (Array.isArray(data[field])) grouped[group] = data[field].map(item => typeof item === 'string' ? item : item?.name).filter(Boolean)
    }
    if (data.language === 11) grouped.language = ['chinese', 'translated']
    tags = Object.keys(grouped).length ? normalizeTags(grouped) : undefined
    const created = typeof data.createdAt === 'number' ? data.createdAt : Date.parse(data.createdAt)
    row = { title: data.title, category: CATEGORIES[Number(data.category) - 1],
      ...(Number.isFinite(created) ? { posted: Math.floor(created > 1e12 ? created / 1000 : created) } : {}) }
  }
  if (typeof row.title !== 'string' || !row.title.trim()) throw new Error('来源响应中缺少有效书名')
  const metadata = { title: decodeText(row.title), ...(tags === undefined ? {} : { tags }), url: location.url }
  for (const field of ['title_jpn', 'category']) if (typeof row[field] === 'string') metadata[field] = decodeText(row[field])
  if (metadata.title.length > 8192 || (metadata.title_jpn?.length || 0) > 8192) throw new Error('来源书名过长')
  for (const field of ['rating', 'posted', 'filecount', 'filesize']) if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
    const number = Number(row[field])
    if (!Number.isFinite(number) || number < 0 || (field === 'rating' ? number > 5 : !Number.isSafeInteger(number))) throw new Error('来源数值字段无效：' + field)
    metadata[field] = number
  }
  return metadata
}

function parseGalleryResults(html, baseURL) {
  const results = new Map()
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    // List layouts put .glink inside the anchor. Other layouts link the title directly.
    if (match[2].includes('<') && !/\bglink\b/i.test(match[0])) continue
    try {
      const location = galleryURL(new URL(decodeText(match[1]), baseURL).href)
      if (location.type !== 'e-hentai') continue
      const title = decodeText(match[2].replace(/<[^>]*>/g, '')).trim()
      if (title && !results.has(location.url)) results.set(location.url, { title, url: location.url, type: location.type })
    } catch { /* Only supported gallery links are returned to the renderer. */ }
    if (results.size >= 80) break
  }
  if (!results.size && /Sad Panda|please (?:log in|login)|login required|You are not logged in/i.test(html)) throw new SourceUnavailableError('来源需要有效的登录 Cookie，请在元数据来源设置中更新')
  return [...results.values()]
}

function createMetadataSources({ getBook, getSettings, saveBook, commit = operation => operation(), request = requestSource, now = Date.now } = {}) {
  const previews = new Map()
  const requestQueue = serialQueue()
  let nextRequestAt = 0
  const clean = () => { for (const [token, preview] of previews) if (preview.expires <= now()) previews.delete(token) }
  const bookFor = async id => {
    if (!validBookId(id)) throw new Error('书籍 ID 无效')
    const book = await getBook(id)
    if (!book) throw new Error('书籍记录不存在')
    return book
  }
  const send = (url, options = {}) => requestQueue(async () => {
    checkCancelled(options.signal)
    const wait = Math.max(0, nextRequestAt - now())
    if (wait) await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); const error = new Error('已取消元数据请求'); error.name = 'AbortError'; reject(error) }
      const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve() }, wait)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
    })
    checkCancelled(options.signal)
    const setting = getSettings()
    const interval = Number.isSafeInteger(setting.requireGap) && setting.requireGap >= 0 && setting.requireGap <= 60000 ? setting.requireGap : 3000
    nextRequestAt = now() + interval
    const response = await request(url, { ...options, cookie: sourceCookie(setting), proxy: setting.proxy || '' })
    checkCancelled(options.signal)
    return response
  })
  async function fetchMetadata(location, signal) {
    const text = location.type === 'e-hentai' ? await send('https://api.e-hentai.org/api.php', {
      method: 'POST', data: { method: 'gdata', gidlist: [[location.gid, location.token]], namespace: 1 }, signal })
      : await send(`https://hentag.com/public/api/vault/${location.id}`, { signal })
    return normalizeMetadata(jsonResponse(text), location)
  }
  return {
    async search({ bookId, source, query = '' }, { signal, exactHash = false } = {}) {
      const book = await bookFor(bookId), setting = getSettings()
      source ||= setting.defaultScraper || 'exhentai'
      if (!SOURCE_TYPES.includes(source) || typeof query !== 'string' || query.length > 1000) throw new Error('元数据搜索参数无效')
      if (source === '.ehviewer') {
        if (book.type !== 'folder') throw new Error('.ehviewer 来源只适用于文件夹书籍')
        await assertWithin(setting.library, book.filepath, true)
        const file = path.join(book.filepath, '.ehviewer')
        await assertWithin(book.filepath, file)
        if ((await fs.stat(file)).size > 65536) throw new Error('.ehviewer 文件过大')
        const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/)
        const location = galleryURL(`https://exhentai.org/g/${lines[2]?.trim()}/${lines[3]?.trim()}/`)
        return [{ title: book.title_jpn || book.title, ...location }]
      }
      const title = query.trim() || book.title_jpn || book.title || path.basename(book.filepath)
      if (source === 'hentag') {
        const data = jsonResponse(await send(`https://hentag.com/public/api/vault-search?t=${encodeURIComponent(title)}`, { signal }))
        if (!Array.isArray(data.works)) throw new Error('来源响应中没有搜索结果列表')
        return data.works.slice(0, 30).flatMap(work => {
          try {
            const external = (work.locations || []).find(url => /^https:\/\/(?:exhentai|e-hentai)\.org\/g\//.test(url))
            const location = galleryURL(external || `https://hentag.com/vault/${work.id}`)
            return [{ title: decodeText(work.title), url: location.url, type: location.type }]
          } catch { return [] }
        })
      }
      const host = ['exhentai', 'exsearch'].includes(source) ? 'exhentai.org' : 'e-hentai.org'
      const url = new URL(`https://${host}/`)
      if (['e-search', 'exsearch'].includes(source)) url.searchParams.set('f_search', title)
      else {
        if (typeof book.hash !== 'string' || !/^[a-f0-9]{40}$/i.test(book.hash)) throw new Error('书籍还没有有效的页面哈希，请刷新本地页数与封面，或选择书名搜索')
        url.searchParams.set('f_shash', book.hash.toUpperCase())
        if (!exactHash) url.searchParams.set('fs_similar', 'on')
        url.searchParams.set('fs_exp', 'on')
      }
      url.searchParams.set('f_cats', '0')
      return parseGalleryResults(await send(url.href, { signal }), url.origin)
    },
    async batch({ books, scope, library, source }, task) {
      const eligible = book => !book.hiddenBook && (scope === 'all' || book.status !== 'tagged')
      const candidates = books.filter(eligible)
      const result = { processed:0, updated:0, unchanged:0, skipped:0, failures:0, cancelled:false }
      const checkpoint = () => {
        checkCancelled(task.signal)
        if ((getSettings().library || '') !== library) throw new SourceUnavailableError('书库目录已改变，请为当前书库重新启动拉取')
      }
      const pullOne = async id => {
        checkpoint()
        const before = await bookFor(id)
        if (!eligible(before)) return 'skipped'
        let url = before.url
        if (!url) {
          const title = before.title_jpn || before.title || ''
          const query = before.type !== 'folder' && title === path.basename(before.filepath || '') ? title.replace(/\.(?:zip|cbz|rar|cbr|7z|cb7)$/i, '') : title
          const matches = await this.search({ bookId:id, source, query:query.slice(0, 1000) }, { signal:task.signal, exactHash:true })
          if (!matches.length) throw new Error('未匹配到作品，可在书籍详情中更换来源或填写画廊链接')
          if (matches.length > 1) throw new Error(`匹配到 ${matches.length} 个候选，请在书籍详情中选择作品`)
          url = matches[0].url
        }
        checkpoint()
        const metadata = await fetchMetadata(galleryURL(url), task.signal)
        return commit(async () => {
          checkpoint()
          const current = await bookFor(id)
          if (!eligible(current)) return 'skipped'
          const fields = Object.keys(metadata)
          if (['hash', 'filepath', 'sourceSignature', 'status', ...fields].some(field => !same(current[field], before[field]))) {
            throw new Error('书籍在拉取期间已修改，请重新拉取')
          }
          if (current.status === 'tagged' && fields.every(field => same(current[field], metadata[field]))) return 'unchanged'
          await saveBook({ id, ...metadata, status:'tagged' })
          return 'updated'
        })
      }
      task.report({ total:candidates.length, current:0 })
      for (const row of candidates) {
        task.report({ filepath:row.filepath, message:'正在匹配并拉取元数据…' })
        let stop = false
        try {
          const outcome = await pullOne(row.id)
          result[outcome]++
        } catch (error) {
          if (task.signal.aborted) { result.cancelled = true; break }
          result.failures++
          stop = error instanceof SourceUnavailableError
          task.error({ bookId:row.id, filepath:row.filepath, message:(stop ? '批量拉取已停止。' : '') + error.message })
        }
        task.report({ current:++result.processed })
        if (stop) break
      }
      return { ...result, changed:result.updated > 0 }
    },
    async preview({ bookId, url }, { signal } = {}) {
      await bookFor(bookId)
      const location = galleryURL(url)
      const metadata = await fetchMetadata(location, signal)
      const book = await bookFor(bookId)
      const changes = Object.keys(metadata).filter(field => !same(book[field], metadata[field]))
        .map(field => ({ field, before: book[field] ?? null, after: metadata[field] }))
      clean()
      if (previews.size >= 30) previews.delete(previews.keys().next().value)
      const previewId = randomUUID(), expires = now() + PREVIEW_TTL
      previews.set(previewId, { bookId, url: location.url, metadata, changes, expires })
      return { previewId, bookId, title: book.title_jpn || book.title, url: location.url, changes: copy(changes), expires }
    },
    getPreview(previewId) {
      clean()
      const preview = previews.get(previewId)
      if (!preview) throw new Error('元数据预览已过期，请重新拉取')
      return { previewId, bookId: preview.bookId, url: preview.url, changes: copy(preview.changes), expires: preview.expires }
    },
    apply({ previewId, fields }) {
      return commit(async () => {
        clean()
        const preview = previews.get(previewId)
        if (!preview) throw new Error('元数据预览已过期，请重新拉取')
        if (!Array.isArray(fields) || fields.length > FIELDS.length || fields.some(field => !FIELDS.includes(field)) || !fields.length) throw new Error('请选择需要应用的元数据字段')
        const selected = [...new Set(fields)], book = await bookFor(preview.bookId), patch = { id: book.id, status: 'tagged' }
        for (const field of selected) {
          const change = preview.changes.find(item => item.field === field)
          if (!change) throw new Error('所选字段不在当前预览中，请重新拉取')
          if (!same(book[field], change.before)) throw new Error('书籍元数据已在预览后修改，请重新拉取；新内容已保留')
          patch[field] = preview.metadata[field]
        }
        const saved = await saveBook(patch)
        previews.delete(previewId)
        return saved
      })
    }
  }
}

module.exports = { SOURCE_HOSTS, SOURCE_TYPES, FIELDS, galleryURL, decodeText, sourceCookie, validateSourceSettings,
  requestSource, normalizeMetadata, parseGalleryResults, createMetadataSources }
