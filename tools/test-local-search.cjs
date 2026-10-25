'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLocalSearchService, validateLocalSearchState, LIMITS } = require('../resources/app/modules/local_search');

const sourceBooks = () => [
  { id: 'forest', title: '林间手记 第一卷', category: 'Artbook', pageCount: 12, tags: { artist: ['青木'], parody: ['Forest Notes'], other: ['水彩', '旅行'] } },
  { id: 'river', title: '河畔速写', category: 'Artbook', pageCount: 8, tags: { artist: ['Aoki'], parody: ['林间手记'], other: ['水彩'] } },
  { id: 'machine', title: '引擎与结构', category: 'Artbook', pageCount: 20, tags: JSON.stringify({ artist: ['工匠'], parody: ['机械图谱'], other: ['图解'] }) },
  { id: 'hidden', title: '隐藏的样本', hiddenBook: true, tags: { artist: ['Aoki'], parody: ['林间手记'] } },
  { id: 'missing', title: '失联的样本', exist: false, tags: { artist: ['Aoki'] } },
];

async function guardedCleanup(directory) {
  const target = path.resolve(directory), parent = path.resolve(os.tmpdir());
  if (path.dirname(target) !== parent || !path.basename(target).startsWith('yanruyu-local-search-')) throw new Error('Refusing cleanup outside the isolated local search fixture');
  await fs.rm(target, { recursive: true, force: true });
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-local-search-'));
  let service, restarted, broken;
  const checks = []; const pass = value => { checks.push(value); console.log('PASS ' + value); };
  const books = sourceBooks(), original = JSON.stringify(books);
  let clock = 1000000;
  try {
    service = createLocalSearchService({ storePath: directory, getBooks: async () => books, now: () => clock });
    const initial = await service.command({ action: 'status' });
    assert.equal(initial.aliases.length, 0); assert.equal(initial.modelBytes, 0); assert.equal(initial.capabilities.neuralSemanticSearch, false);
    await assert.rejects(fs.stat(path.join(directory, 'local-search.json')), { code: 'ENOENT' });
    pass('read-only startup creates no persistent file and reports the exact supported retrieval capabilities');

    const baseline = await service.command({ action: 'search', query: '青木' });
    assert.deepEqual(baseline.results.map(item => item.bookId), ['forest']);
    const preview = await service.command({ action: 'preview-alias', kind: 'author', canonical: '青木', aliases: ['Aoki', 'AOKI'] });
    assert.equal(preview.affectedCount, 3); assert(!preview.affectedBooks.some(item => item.bookId === 'hidden'));
    assert.equal((await service.snapshot()).aliases.length, 0);
    assert.equal(JSON.stringify(books), original);
    assert.deepEqual(preview.alias.aliases, ['Aoki']);
    await assert.rejects(service.command({ action: 'save-alias', token: 'unknown' }), /预览/);
    await service.command({ action: 'save-alias', token: preview.token });
    const found = await service.command({ action: 'search', query: '青木' });
    assert.deepEqual(new Set(found.results.map(item => item.bookId)), new Set(['forest', 'river', 'missing']));
    assert(found.results.find(item => item.bookId === 'river').reasons.some(reason => reason.includes('作者别名')));
    assert.equal((await service.command({ action: 'search', query: 'Ａｏｋｉ' })).total, 3);
    pass('alias preview is nonmutating; confirmed author aliases improve recall from 1/3 to 3/3 without exposing hidden books');

    const seriesPreview = await service.command({ action: 'preview-alias', kind: 'series', canonical: '林间手记', aliases: ['Forest Notes'] });
    await service.command({ action: 'save-alias', token: seriesPreview.token });
    await assert.rejects(service.command({ action: 'preview-alias', kind: 'author', canonical: '另一个人', aliases: ['aoki'] }), /另一组/);
    const recommendations = await service.command({ action: 'recommend', bookId: 'forest' });
    assert.equal(recommendations.results[0].bookId, 'river');
    assert(recommendations.results[0].reasons.some(reason => reason.includes('同一作者：青木')));
    assert(recommendations.results[0].reasons.some(reason => reason.includes('同一系列：林间手记')));
    assert(!recommendations.results.some(item => ['hidden', 'missing', 'machine'].includes(item.bookId)));
    assert.equal((await service.command({ action: 'search', query: 'Forest Notes' })).results.filter(item => item.bookId === 'river').length, 1);
    pass('author and series aliases are unambiguous; recommendations explain evidence and exclude unrelated, hidden and missing books');

    const { LibraryIndex } = await import(pathToFileURL(path.join(__dirname, '../resources/app/dist/room-library.js')).href);
    const { applyDiscoveryAliases } = await import(pathToFileURL(path.join(__dirname, '../resources/app/dist/room-discovery.js')).href);
    const index = new LibraryIndex(books);
    applyDiscoveryAliases(index, (await service.snapshot()).aliases);
    assert.equal(index.select({ search: '青木' }).length, 3);
    const searchLength = index.metadata.get('river').search.length;
    applyDiscoveryAliases(index, (await service.snapshot()).aliases);
    assert.equal(index.metadata.get('river').search.length, searchLength);
    applyDiscoveryAliases(index, []);
    assert.equal(index.select({ search: '青木' }).length, 1);
    assert.equal(JSON.stringify(books), original);
    pass('the actual LibraryIndex hook expands main search, avoids repeated growth and removes deleted aliases without rewriting books');

    const stale = await service.command({ action: 'preview-alias', kind: 'author', canonical: '丙', aliases: ['Gamma'] });
    await service.command({ action: 'pause' });
    await assert.rejects(service.command({ action: 'save-alias', token: stale.token }), /已过期|变化/);
    const expired = await service.command({ action: 'preview-alias', kind: 'author', canonical: '丁', aliases: ['Delta'] });
    clock += 11 * 60 * 1000;
    await assert.rejects(service.command({ action: 'save-alias', token: expired.token }), /已过期/);
    pass('stale and expired confirmations cannot apply a changed preview');

    const corpus = [
      ['forest', 3, '清晨的森林里，阳光穿过树叶，远处传来鸟鸣。我们沿着山间小路步行。'],
      ['river', 5, '河边的水彩写生。夕阳映照河面，旅人收起画笔。'],
      ['machine', 2, 'The engine diagram shows the copper gear assembly and cooling valve.'],
    ];
    for (const [bookId, page, text] of corpus) {
      const prepared = await service.command({ action: 'preview-text', bookId, page, text });
      assert.equal(prepared.replacesExisting, false);
      await service.command({ action: 'save-text', token: prepared.token });
    }
    let status = await service.waitForIdle();
    assert.equal(status.savedPages, 3); assert.equal(status.indexedPages, 0); assert.equal(status.pendingPages, 3);
    assert.equal((await service.command({ action: 'search', query: 'copper gear', mode: 'text' })).total, 0);
    await service.command({ action: 'resume' }); status = await service.waitForIdle();
    assert.equal(status.indexedPages, 3); assert.equal(status.pendingPages, 0);
    assert(status.estimatedIndexBytes > 0); assert.equal(status.textBytes, corpus.reduce((sum, row) => sum + Buffer.byteLength(row[2]), 0));
    pass('paused imports persist without indexing; resume builds bounded indexes and reports real corpus cost');

    const evaluation = [
      { query: '鸟鸣', expected: 'forest', page: 3 },
      { query: '水彩 写生', expected: 'river', page: 5 },
      { query: 'copper gear', expected: 'machine', page: 2 },
    ];
    let top1 = 0;
    for (const sample of evaluation) {
      const result = await service.command({ action: 'search', query: sample.query, mode: 'text' });
      if (result.results[0]?.bookId === sample.expected) top1++;
      assert.equal(result.results[0]?.bookId, sample.expected); assert.equal(result.results[0]?.page, sample.page);
      assert(result.results[0].matches[0].snippet.length <= 185);
    }
    assert.equal((await service.command({ action: 'search', query: 'satellite observatory', mode: 'text' })).total, 0);
    // Lexical matching does not pretend to understand unrelated synonyms.
    assert.equal((await service.command({ action: 'search', query: 'automobile', mode: 'text' })).total, 0);
    pass(`neutral held-out queries retrieve the expected book and one-based page: top-1 ${top1}/${evaluation.length}; negative controls remain empty`);

    books.find(item => item.id === 'forest').hiddenBook = true;
    assert.equal((await service.command({ action: 'search', query: '鸟鸣', mode: 'text' })).total, 0);
    await assert.rejects(service.command({ action: 'get-text', bookId: 'forest', page: 3 }), /隐藏/);
    books.find(item => item.id === 'forest').hiddenBook = false;
    await assert.rejects(service.command({ action: 'preview-text', bookId: 'forest', page: 13, text: 'beyond book' }), /只有 12 页/);
    await assert.rejects(service.command({ action: 'preview-text', bookId: 'unknown', page: 1, text: 'not a book' }), /不存在/);
    await assert.rejects(service.command({ action: 'preview-text', bookId: 'forest', page: 1, text: 'a'.repeat(LIMITS.charactersPerPage + 1) }), /文本页格式/);
    await assert.rejects(service.command({ action: 'clear-texts' }), /确认/);
    pass('book visibility, page bounds, text size and destructive corpus confirmation are validated by the service');

    const replacement = await service.command({ action: 'preview-text', bookId: 'machine', page: 2, text: 'A stainless spring replaces the old assembly.' });
    assert.equal(replacement.replacesExisting, true);
    assert((await service.command({ action: 'get-text', bookId: 'machine', page: 2 })).text.includes('copper'));
    await service.command({ action: 'save-text', token: replacement.token }); await service.waitForIdle();
    assert.equal((await service.command({ action: 'search', query: 'copper gear', mode: 'text' })).total, 0);
    assert.equal((await service.command({ action: 'search', query: 'stainless spring', mode: 'text' })).results[0].bookId, 'machine');
    pass('confirmed page replacement invalidates old terms immediately');

    await service.flush();
    const persisted = validateLocalSearchState(JSON.parse(await fs.readFile(path.join(directory, 'local-search.json'), 'utf8')));
    assert.equal(persisted.aliases.length, 2); assert.equal(persisted.texts.length, 3);
    restarted = createLocalSearchService({ storePath: directory, getBooks: async () => books });
    await restarted.waitForIdle();
    assert.equal((await restarted.command({ action: 'search', query: 'stainless spring', mode: 'text' })).total, 1);
    await restarted.command({ action: 'clear-index' }); status = await restarted.waitForIdle();
    assert.equal(status.indexedPages, 0); assert.equal(status.savedPages, 3); assert.equal(status.paused, true);
    await restarted.command({ action: 'resume' }); await restarted.waitForIdle();
    assert.equal((await restarted.command({ action: 'search', query: '鸟鸣', mode: 'text' })).total, 1);
    pass('restart restores aliases/text; clearing the derived index preserves originals and allows rebuilding');

    const selectedText = await restarted.command({ action: 'get-text', bookId: 'river', page: 5 });
    await assert.rejects(restarted.command({ action: 'remove-text', bookId: 'river', page: 5, revision: -1 }), /变化/);
    await restarted.command({ action: 'remove-text', bookId: 'river', page: 5, revision: selectedText.revision });
    await restarted.command({ action: 'clear-texts', confirmation: '清除全部导入文本' });
    status = await restarted.snapshot(); assert.equal(status.savedPages, 0); assert.equal(status.aliases.length, 2);
    const rule = status.aliases.find(item => item.kind === 'author');
    const removal = await restarted.command({ action: 'preview-alias', operation: 'delete', id: rule.id });
    assert.equal((await restarted.snapshot()).aliases.length, 2);
    await restarted.command({ action: 'save-alias', token: removal.token });
    assert.equal((await restarted.snapshot()).aliases.length, 1);
    pass('individual/full text clearing and alias deletion retain unrelated settings and require the correct confirmation');

    const badDirectory = path.join(directory, 'corrupt'); await fs.mkdir(badDirectory);
    await fs.writeFile(path.join(badDirectory, 'local-search.json'), '{invalid');
    broken = createLocalSearchService({ storePath: badDirectory, getBooks: async () => books });
    await assert.rejects(broken.command({ action: 'resume' }));
    assert.equal(await fs.readFile(path.join(badDirectory, 'local-search.json'), 'utf8'), '{invalid');
    assert.throws(() => validateLocalSearchState({ ...persisted, aliases: [{ kind: 'author', canonical: 'a', aliases: ['b'] }] }), /ID/);
    assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp')), false);
    pass('corrupt or malformed saved data is not overwritten and atomic saves leave no temporary files');
    console.log(JSON.stringify({ suite: 'local-search', checks: checks.length, sampleQueries: evaluation.length, top1, externalRequests: 0 }));
  } finally {
    await service?.dispose().catch(() => {}); await restarted?.dispose().catch(() => {}); await broken?.dispose().catch(() => {});
    await guardedCleanup(directory);
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main, sourceBooks, guardedCleanup };
