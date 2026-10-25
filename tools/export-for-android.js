/*
 * 把 exhentai-manga-manager 的书库导出成安卓阅读器能识别的格式。
 *
 * 两种布局：
 *   --layout ehviewer  (默认) EhViewer FooIbar 分支 → 设置-下载-"恢复下载项"
 *                      会读 ComicInfo.xml 的 <Web> 字段，调 E-Hentai API 自动刮回
 *                      完整命名空间标签/评分/发布日期。元数据最全。
 *   --layout mihon     Mihon / TachiyomiSY / Komikku 的本地源(local/系列/章节/图片)
 *                      只读本地 ComicInfo.xml，不联网。阅读体验更好，标签被压平。
 *
 * 只读原库，输出到独立目录，绝不修改 E:\Comic 里的任何文件。
 *
 *   node export-for-android.js --out D:\ToPhone                    # 全部，EhViewer 布局
 *   node export-for-android.js --out D:\ToPhone --layout mihon     # Mihon 布局
 *   node export-for-android.js --out D:\ToPhone --limit 3          # 只导前 3 本
 *   node export-for-android.js --out D:\ToPhone --dry              # 只看计划，不写盘
 *   node export-for-android.js --out D:\ToPhone --link             # 硬链接(同盘秒完成,不占空间)
 *   node export-for-android.js --out D:\ToPhone --filter 玉之けだま  # 按关键字挑
 *   node export-for-android.js --out D:\ToPhone --marked           # 只导已收藏的
 */
const fs = require('fs')
const path = require('path')
const sqlite3 = require('../resources/app/node_modules/sqlite3')

const STORE = path.resolve(__dirname, '..')
const IMG_RE = /\.(jpg|jpeg|png|webp|avif|gif)$/i
// EhViewer GalleryDetailUrlParser.URL_STRICT_PATTERN
const URL_RE = /^https?:\/\/(?:exhentai\.org|e-hentai\.org(?:\/lofi)?)\/(?:g|mpv)\/(\d+)\/([0-9a-f]{10})/

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] ?? true) : d }
const OUT = arg('out')
const DRY = argv.includes('--dry')
const LINK = argv.includes('--link')
const MARKED = argv.includes('--marked')
const LIMIT = Number(arg('limit', 0)) || 0
const FILTER = arg('filter', null)
const LAYOUT = String(arg('layout', 'ehviewer')).toLowerCase()

if (!OUT) { console.error('用法: node export-for-android.js --out <输出目录> [--layout ehviewer|mihon] [--dry] [--link] [--limit N] [--filter 关键字] [--marked]'); process.exit(1) }
if (!['ehviewer', 'mihon'].includes(LAYOUT)) { console.error(`--layout 只能是 ehviewer 或 mihon，收到: ${LAYOUT}`); process.exit(1) }

const openDb = f => new Promise((res, rej) => { const d = new sqlite3.Database(f, sqlite3.OPEN_READONLY, e => e ? rej(e) : res(d)) })
const queryAll = (db, q) => new Promise((res, rej) => db.all(q, (e, r) => e ? rej(e) : res(r)))

// Windows 文件名净化 + 长度限制(EhViewer 侧目录名任意,但要能落地)
const sanitize = s => s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'untitled'
const xmlEscape = s => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
// 与桌面端 fileLoader 完全一致的自然排序,保证阅读顺序不变
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

const tagsOf = b => { try { return JSON.parse(b.tags || '{}') } catch { return {} } }
const joinTags = (t, ...ns) => ns.flatMap(n => Array.isArray(t[n]) ? t[n] : []).join(', ')

/*
 * 两个阅读器读的字段完全不同,所以分开生成:
 *  - EhViewer 只需要 <Web> 就能调 API 刮回全部元数据,其余字段是刮削失败时的兜底。
 *  - Mihon 的 copyFromComicInfo 只读 Series/Writer/Summary/Genre+Tags/Penciller 系列,
 *    LanguageISO、PageCount、CommunityRating、Web 一概不解析,所以评分/发布日期/链接
 *    必须塞进 Summary 才看得到。
 */
const buildComicInfo = (b, layout) => {
  const t = tagsOf(b)
  const lang = (t.language || []).find(l => l !== 'translated')
  const pencil = joinTags(t, 'artist', 'cosplayer')
  const writer = joinTags(t, 'group')
  const chars = joinTags(t, 'character')
  const teams = (t.parody || []).filter(p => p !== 'original').join(', ')
  const posted = b.posted ? new Date(b.posted * 1000).toISOString().slice(0, 10) : null
  const f = []

  if (layout === 'mihon') {
    // Mihon 把 Genre + Tags 合并去重后当作 genre 展示,所以把全部命名空间标签铺进去
    const flat = []
    for (const [ns, vals] of Object.entries(t)) {
      if (!Array.isArray(vals)) continue
      vals.forEach(v => flat.push(`${ns}:${v}`))
    }
    const summary = [
      b.title_jpn || null,
      b.category ? `分类: ${b.category}` : null,
      b.rating != null ? `评分: ${Number(b.rating).toFixed(2)}` : null,
      posted ? `发布: ${posted}` : null,
      b.pageCount ? `页数: ${b.pageCount}` : null,
      b.url || null,
    ].filter(Boolean).join('\n')
    f.push(['Series', b.title])
    if (writer) f.push(['Writer', writer])
    if (pencil) f.push(['Penciller', pencil])
    if (summary) f.push(['Summary', summary])
    if (b.category) f.push(['Genre', b.category])
    if (flat.length) f.push(['Tags', flat.join(', ')])
  } else {
    // 对齐 EhViewer spider/ComicInfo.kt 的字段映射
    const genre = [
      ...(t.other || []), ...(t.location || []),
      ...(t.female || []).map(x => 'f:' + x),
      ...(t.male || []).map(x => 'm:' + x),
      ...(t.mixed || []).map(x => 'x:' + x),
    ].join(', ')
    f.push(['Series', b.title])
    if (b.title_jpn) f.push(['AlternateSeries', b.title_jpn])
    if (writer) f.push(['Writer', writer])
    if (pencil) f.push(['Penciller', pencil])
    if (genre) f.push(['Genre', genre])
    if (chars) f.push(['Characters', chars])
    if (teams) f.push(['Teams', teams])
    if (lang) f.push(['LanguageISO', lang])
    if (b.pageCount) f.push(['PageCount', b.pageCount])
    if (b.rating != null) f.push(['CommunityRating', Number(b.rating).toFixed(1)])
    if (b.category) f.push(['Tags', b.category])
    f.push(['Web', b.url])        // ← "恢复下载项"唯一必需的字段
  }
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:noNamespaceSchemaLocation="https://raw.githubusercontent.com/anansi-project/comicinfo/main/schema/v2.0/ComicInfo.xsd">\n' +
    f.map(([k, v]) => `  <${k}>${xmlEscape(v)}</${k}>`).join('\n') + '\n</ComicInfo>\n'
}

;(async () => {
  const db = await openDb(path.join(STORE, 'database.sqlite'))
  let books = await queryAll(db, 'select * from Mangas')

  if (FILTER && FILTER !== true) books = books.filter(b => (b.title || '').includes(FILTER) || (b.filepath || '').includes(FILTER))
  if (MARKED) books = books.filter(b => b.mark)
  if (LIMIT) books = books.slice(0, LIMIT)

  // Mihon 要求书都放在名为 local 的目录下
  const ROOT = LAYOUT === 'mihon' ? path.join(OUT, 'local') : OUT
  console.log(`候选 ${books.length} 本  ->  ${ROOT}`)
  console.log(`布局 ${LAYOUT}${DRY ? '   [DRY RUN 不写盘]' : ''}${LINK ? '   [硬链接模式]' : ''}\n`)
  if (!DRY) fs.mkdirSync(ROOT, { recursive: true })

  const skipped = []
  let done = 0, pages = 0, bytes = 0
  const manifest = []

  const place = (from, to) => {
    if (DRY) return
    try { fs.rmSync(to, { force: true }) } catch {}
    if (LINK) { try { fs.linkSync(from, to) } catch { fs.copyFileSync(from, to) } }
    else fs.copyFileSync(from, to)
  }

  for (const b of books) {
    const m = URL_RE.exec(b.url || '')
    // EhViewer 靠 <Web> 反查 gid/token,没有就无法恢复;Mihon 不联网,缺链接也能用
    if (!m && LAYOUT === 'ehviewer') { skipped.push([b.title, b.url ? 'URL 不符合 EhViewer 解析规则' : '缺少 E-Hentai 链接']); continue }
    if (!fs.existsSync(b.filepath)) { skipped.push([b.title, '源目录已不存在']); continue }

    const imgs = fs.readdirSync(b.filepath).filter(f => IMG_RE.test(f)).sort(naturalSort)
    if (!imgs.length) { skipped.push([b.title, '目录内没有图片']); continue }

    // EhViewer 用 gid-title 风格;Mihon 的目录名会被直接当作系列标题显示
    const dirName = LAYOUT === 'mihon' ? sanitize(b.title) : sanitize(`${m[1]}-${b.title}`)
    const seriesDir = path.join(ROOT, dirName)
    // Mihon 需要 系列/章节/图片 两层;EhViewer 是单层
    const imgDir = LAYOUT === 'mihon' ? path.join(seriesDir, 'ch1') : seriesDir
    if (!DRY) fs.mkdirSync(imgDir, { recursive: true })

    const map = []
    imgs.forEach((src, i) => {
      const ext = path.extname(src).slice(1).toLowerCase()
      // EhViewer 的 FileNameRegex 要求 ^\d{8}\.\w{3,4};Mihon 只按文件名排序,补零即可
      const target = `${String(i + 1).padStart(8, '0')}.${ext}`
      place(path.join(b.filepath, src), path.join(imgDir, target))
      bytes += fs.statSync(path.join(b.filepath, src)).size
      map.push([src, target])
    })

    if (!DRY) fs.writeFileSync(path.join(seriesDir, 'ComicInfo.xml'), buildComicInfo(b, LAYOUT), 'utf-8')
    // Mihon 认系列根目录下 basename 为 cover 的图片;直接复用桌面端已生成的 500x707 封面
    if (LAYOUT === 'mihon' && b.coverPath && fs.existsSync(b.coverPath)) {
      place(b.coverPath, path.join(seriesDir, 'cover' + path.extname(b.coverPath)))
    }

    manifest.push({ gid: m?.[1] ?? null, token: m?.[2] ?? null, title: b.title, src: b.filepath, dest: dirName, pages: imgs.length, rename: map })
    pages += imgs.length; done++
    if (done % 10 === 0 || done === books.length) process.stdout.write(`\r  已处理 ${done}/${books.length} 本, ${pages} 页`)
  }
  console.log()

  // 留一份还原清单,方便核对原始文件名与新序号的对应关系
  if (!DRY) fs.writeFileSync(path.join(OUT, '_manifest.json'), JSON.stringify(manifest, null, 1), 'utf-8')

  console.log(`\n导出完成: ${done} 本 / ${pages} 页 / ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`)
  if (skipped.length) {
    console.log(`\n跳过 ${skipped.length} 本:`)
    skipped.slice(0, 20).forEach(([t, why]) => console.log(`   ${why.padEnd(28)} ${String(t).slice(0, 50)}`))
  }
  console.log('\n手机端操作:')
  if (LAYOUT === 'ehviewer') {
    console.log(`  1. 把 ${ROOT} 下的书目录拷进手机上 EhViewer 的下载目录`)
    console.log('  2. EhViewer -> 设置 -> 下载 -> 恢复下载项')
    console.log('  3. 需要能连上 E-Hentai(代理/VPN),它会自动刮回标签、评分、发布日期、缩略图')
  } else {
    console.log(`  1. 把 ${ROOT} 整个 local 目录拷到手机上 Mihon 的存储位置下`)
    console.log('  2. Mihon -> 设置 -> 数据和存储 -> 确认存储位置,然后在书库刷新本地源')
    console.log('  3. 全程离线,不需要代理;但标签是扁平字符串,评分/发布日期在简介里')
  }
})().catch(e => { console.error('ERR', e); process.exit(1) })
