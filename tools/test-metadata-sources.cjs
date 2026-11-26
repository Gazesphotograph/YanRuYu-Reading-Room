'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { requestSource, galleryURL, normalizeMetadata, parseGalleryResults, validateSourceSettings, createMetadataSources, decodeText } = require('../resources/app/modules/metadata_sources');
const { createReadingStateStore } = require('../resources/app/modules/reading_state');
const url = 'https://exhentai.org/g/123/abcdef1234/';
const data = { gmetadata: [{ gid: 123, token: 'abcdef1234', title: 'River &amp; Lines', title_jpn: '中性&#x6863;案', tags: ['artist:River Studio', 'other:quiet:objects', 'neutral'], category: 'Non-H', rating: '4.5', filecount: '6', posted: '1700000000', filesize: '400' }] };

test('source requests surface HTTP, empty, rate-limit and connection failures', async () => {
  await assert.rejects(requestSource(url, { fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403.*Cookie/);
  await assert.rejects(requestSource(url, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(requestSource(url, { fetchImpl: async () => ({ ok: true, text: async () => ' ' }) }), /空内容/);
  await assert.rejects(requestSource(url, { fetchImpl: async () => ({ ok:true, headers:{get:()=> 'image/gif'}, text:async()=> 'fixture image' }) }), /登录 Cookie/);
  await assert.rejects(requestSource(url, { fetchImpl: async () => ({ ok: true, text: async () => 'Your IP address has been temporarily banned' }) }), /限制/);
  await assert.rejects(requestSource(url, { fetchImpl: async () => { const error = new Error('contains private proxy credentials'); error.name = 'FetchError'; throw error; } }), error => /无法连接/.test(error.message) && !/private/.test(error.message));
  await assert.rejects(requestSource('https://example.com/g/123/abcdef1234/'), /URL is not allowed/);
});

test('timeouts and cancellation abort an active request and cookie stays on its source', async () => {
  const waitForAbort = (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { const error = new Error('abort'); error.name = 'AbortError'; reject(error); }, { once: true }));
  await assert.rejects(requestSource(url, { timeoutMs: 15, fetchImpl: waitForAbort }), error => error.name === 'TimeoutError' && /超时/.test(error.message));
  const controller = new AbortController();
  const request = requestSource(url, { signal: controller.signal, fetchImpl: waitForAbort });
  controller.abort();
  await assert.rejects(request, error => error.name === 'AbortError');
  const seen = [];
  const capture = async (address, options) => { seen.push({ address, options }); return { ok: true, text: async () => '{}' }; };
  await requestSource(url, { cookie: 'igneous=private', fetchImpl: capture });
  await requestSource('https://hentag.com/public/api/vault/abc', { cookie: 'igneous=private', fetchImpl: capture });
  assert.equal(seen[0].options.headers.Cookie, 'igneous=private');
  assert.equal(seen[1].options.headers.Cookie, undefined);
  await requestSource('https://api.e-hentai.org/api.php', { method:'POST', data:{}, cookie:'igneous=private', fetchImpl:capture });
  assert.equal(seen[2].options.headers.Cookie, undefined);
  assert.equal(seen[0].options.redirect, 'error');
  assert.equal(seen[0].options.size, 16 * 1024 ** 2);
});

test('metadata and search responses normalize safely and validate the requested gallery', () => {
  const metadata = normalizeMetadata(data, galleryURL(url));
  assert.equal(metadata.title, 'River & Lines');
  assert.equal(metadata.title_jpn, '中性档案');
  assert.equal(decodeText('Caf&eacute; &NotEqualTilde;'), 'Café ≂̸');
  assert.equal(metadata.rating, 4.5);
  assert.deepEqual(JSON.parse(JSON.stringify(metadata.tags)), { artist: ['River Studio'], other: ['quiet:objects'], misc: ['neutral'] });
  assert.throws(() => normalizeMetadata({ gmetadata: [{ ...data.gmetadata[0], gid: 999 }] }, galleryURL(url)), /不一致/);
  assert.throws(() => normalizeMetadata({ gmetadata: [{ error: 'not found' }] }, galleryURL(url)), /不可用/);
  assert.equal(normalizeMetadata({ title: 'Neutral', artists: [{ name: 'A' }] }, galleryURL('https://hentag.com/vault/work-1')).tags.artist[0], 'A');
  const html = `<a href="${url}"><div class="glink">Neutral &amp; calm</div></a><a href="${url}"><span class="glink">Duplicate</span></a><a href="https://other.example/g/1/abcde/"><span class="glink">Ignored</span></a>`;
  assert.deepEqual(parseGalleryResults(html), [{ title: 'Neutral & calm', url, type: 'e-hentai' }]);
  assert.throws(() => parseGalleryResults('Sad Panda, please login'), /Cookie/);
});

test('preview does not edit books and selected fields preserve identity, covers, progress and favorites', async () => {
  let book = { id: 'book', title: 'Local', title_jpn: '', tags: { artist: ['Local Artist'] }, filepath: 'local', hash: 'a'.repeat(40), coverPath: 'custom-cover', pageCount: 4, readCount: 7, mark: false, rating: 2 };
  const original = structuredClone(book), writes = [];
  const service = createMetadataSources({ getBook: async () => book, getSettings: () => ({ requireGap: 0 }), request: async () => JSON.stringify(data), saveBook: async patch => { writes.push(patch); book = { ...book, ...patch }; return book; } });
  const preview = await service.preview({ bookId: 'book', url });
  assert.deepEqual(book, original);
  book.mark = true; book.readCount = 8; book.pageCount = 5;
  await service.apply({ previewId: preview.previewId, fields: ['title', 'tags'] });
  assert.equal(book.title, 'River & Lines');
  assert.equal(book.mark, true); assert.equal(book.readCount, 8); assert.equal(book.pageCount, 5); assert.equal(book.coverPath, 'custom-cover'); assert.equal(book.rating, 2);
  assert.deepEqual(Object.keys(writes[0]).sort(), ['id', 'status', 'tags', 'title']);
  await assert.rejects(service.apply({ previewId: preview.previewId, fields: ['title'] }), /过期/);
});

test('preview rejects concurrent edits, remains retryable after failed writes, and expires', async () => {
  let book = { id: 'book', title: 'Local', tags: {} }, fail = false, time = 10;
  const service = createMetadataSources({ getBook: async () => book, getSettings: () => ({ requireGap: 0 }), request: async () => JSON.stringify(data), now: () => time,
    saveBook: async patch => { if (fail) throw new Error('fixture read-only'); book = { ...book, ...patch }; return book; } });
  const conflict = await service.preview({ bookId: 'book', url });
  book.title = 'New user title';
  await assert.rejects(service.apply({ previewId: conflict.previewId, fields: ['title'] }), /预览后修改/);
  assert.equal(book.title, 'New user title');
  const retry = await service.preview({ bookId: 'book', url });
  fail = true;
  await assert.rejects(service.apply({ previewId: retry.previewId, fields: ['title'] }), /read-only/);
  fail = false;
  await service.apply({ previewId: retry.previewId, fields: ['title'] });
  const expired = await service.preview({ bookId: 'book', url });
  time += 11 * 60 * 1000;
  assert.throws(() => service.getPreview(expired.previewId), /过期/);
});

test('book-name queries encode delimiters, and source settings only change allowed fields', async () => {
  let requested;
  const service = createMetadataSources({ getBook: async () => ({ id: 'book', title: 'Neutral', hash: 'a'.repeat(40) }), getSettings: () => ({ requireGap: 0 }), request: async address => { requested = new URL(address); return '<html>no results</html>'; } });
  await service.search({ bookId: 'book', source: 'e-search', query: 'quiet & calm? 中文' });
  assert.equal(requested.searchParams.get('f_search'), 'quiet & calm? 中文');
  assert.equal(requested.searchParams.get('f_cats'), '0');
  const setting = validateSourceSettings({ library: 'existing', keepReadingProgress: true }, { proxy: 'http://127.0.0.1:7890', defaultScraper: 'hentag', requireGap: 0, igneous: '' });
  assert.equal(setting.library, 'existing'); assert.equal(setting.keepReadingProgress, true);
  assert.throws(() => validateSourceSettings(setting, { library: 'changed' }), /无效/);
  assert.throws(() => validateSourceSettings(setting, { ipb_pass_hash: 'bad;cookie' }), /Cookie/);
});

test('Chinese filename markers participate in tag filters without rewriting local or fetched tags', async () => {
  const { LibraryIndex, tagKey } = await import('../resources/app/dist/room-library.js');
  const books = [
    { id:'scanned', filepath:'Quiet [Chinese].cbz', tags:{} },
    { id:'folder', filepath:'Book shelf/静物【中国翻訳】/', tags:null },
    { id:'parent', filepath:'[Chinese]/静物.cbz' },
    { id:'text', filepath:'Chinese Art Book.cbz' },
    { id:'fetched', filepath:'Quiet [Chinese].cbz', tags:{language:['english']} },
  ];
  const key = tagKey('language', 'chinese');
  const progress = { scanned:{ page:3, total:95, time:1000 } };
  const index = new LibraryIndex(books);
  assert.equal(index.tags.get(key).count, 2);
  assert.deepEqual(index.select({filter:'reading', progress, selectedTags:[key]}).map(book => book.id), ['scanned']);
  assert.equal(index.select({filter:'reading', progress, excludedTags:[key]}).length, 0);
  assert.deepEqual(books[0].tags, {});
});

test('batch matches the whole scope, reports ambiguous or absent matches and retries only untagged books by default', async () => {
  const books = ['linked','unique','ambiguous','absent','tagged','hidden'].map(id => ({
    id, filepath:id + '.cbz', title:id, mark:true, pageCount:95, readCount:3,
    url:['linked','tagged'].includes(id) ? url : '', hiddenBook:id === 'hidden', status:id === 'tagged' ? 'tagged' : 'non-tag',
  }));
  const errors = [], queries = [], writes = [];
  const service = createMetadataSources({ getBook:async id => structuredClone(books.find(book => book.id === id)),
    getSettings:() => ({ library:'fixture', requireGap:0 }),
    saveBook:async patch => { writes.push(patch.id); Object.assign(books.find(book => book.id === patch.id), patch); },
    request:async address => {
      if (new URL(address).hostname === 'api.e-hentai.org') return JSON.stringify(data);
      const title = new URL(address).searchParams.get('f_search'); queries.push(title);
      return title === 'absent' ? '' : `<a href="${url}">First</a>` + (title === 'ambiguous' ? '<a href="/g/456/abcde/">Second</a>' : '');
    } });
  const task = { signal:new AbortController().signal, report() {}, error:item => errors.push(item) };
  const run = scope => service.batch({ books, scope, source:'exsearch', library:'fixture' }, task);
  const first = await run('missing');
  assert.deepEqual(writes, ['linked','unique']);
  assert.deepEqual(queries, ['unique','ambiguous','absent']);
  assert.equal(first.failures, 2);
  assert.match(errors[0].message, /2 个候选/);
  assert.match(errors[1].message, /未匹配/);
  assert.equal((await run('missing')).processed, 2);
  const all = await run('all');
  assert.equal(all.unchanged, 2); assert.equal(all.updated, 1);
  assert.deepEqual(writes, ['linked','unique','tagged']);
  assert(books.every(book => book.mark && book.readCount === 3 && book.pageCount === 95));
});

test('cancellation, source throttling and edits during a batch preserve completed and concurrent work', async () => {
  for (const mode of ['cancel', 'rate-limit', 'edited']) {
    const controller = new AbortController();
    const books = ['one','two','three'].map(id => ({ id, title:id, filepath:id, url, status:'non-tag' }));
    let requests = 0;
    const service = createMetadataSources({
      getSettings:() => ({library:'fixture', requireGap:0}), getBook:async id => structuredClone(books.find(book => book.id === id)),
      saveBook:async patch => Object.assign(books.find(book => book.id === patch.id), patch),
      request:async address => {
        if (++requests === 2) {
          if (mode === 'cancel') controller.abort();
          if (mode === 'edited') books[1].title = 'local edit';
          if (mode === 'rate-limit') return requestSource(address, {fetchImpl:async () => ({ok:false, status:429})});
        }
        return JSON.stringify(data);
      }
    });
    const result = await service.batch({ books, scope:'missing', source:'exhentai', library:'fixture' },
      { signal:controller.signal, report() {}, error() {} });
    assert.equal(books[0].status, 'tagged'); assert.equal(books[1].status, 'non-tag');
    assert.equal(result.cancelled, mode === 'cancel');
    assert.equal(result.failures, mode === 'cancel' ? 0 : 1);
    assert.equal(requests, mode === 'edited' ? 3 : 2);
    if (mode === 'edited') assert.equal(books[1].title, 'local edit');
  }
});

test('already migrated histories recover open-only records without inventing a page and persist external visits', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-open-history-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const old = { schemaVersion: 1, pageBase: 1, revision: 3, progress: { internal: { page: 2, total: 4, time: 5000 } }, preferences: {}, migrations: { legacyV1: { imported: 1 } },
    migrationSnapshots: [{ storage: { recentRead: JSON.stringify([{ id: 'open-only', read_time: 7 }]) } }] };
  await fs.writeFile(path.join(directory, 'reading-state.json'), JSON.stringify(old));
  const store = createReadingStateStore({ storePath: directory }), upgraded = await store.load();
  assert.deepEqual(upgraded.visits['open-only'], { time: 7000, source: 'migration' });
  assert.equal(upgraded.progress['open-only'], undefined);
  assert.equal(upgraded.progress.internal.page, 2);
  await store.saveVisit('external', { time: 9000, source: 'external' });
  const current=await store.load();
  assert.deepEqual(await store.saveVisit('external',{time:8000,source:'migration'}),{time:9000,source:'external'});
  assert.equal((await store.load()).revision,current.revision,'Retrying an older visit does not replace a newer acknowledged record');
  const restarted = await createReadingStateStore({ storePath: directory }).load();
  assert.equal(restarted.visits.external.source, 'external');
  assert.equal(restarted.progress.external, undefined);
  assert.equal(restarted.revision, upgraded.revision + 1);
});
