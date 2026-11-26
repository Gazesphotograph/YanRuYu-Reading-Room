'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const { fs, path, root, sha256, isWithin, electronExecutable } = require('./project/common.cjs');
const { build } = require('./project/build.cjs');
const { _electron } = require('./playwright-runtime.cjs');

async function main() {
  const reusable = process.env.YANRUYU_TEST_BUILD && path.resolve(process.env.YANRUYU_TEST_BUILD);
  if (reusable && (!isWithin(path.join(root, '.build'), reusable) || reusable === path.join(root, '.build'))) {
    throw new Error('The reusable build must be a staging directory below .build/.');
  }
  const target = reusable ? { folder: reusable, app: path.join(reusable, 'resources', 'app') } : build();
  const native = name => require(path.join(target.app, 'node_modules', name));
  const { open } = native('sqlite');
  const { Database } = native('sqlite3');
  const sharp = native('sharp');
  const temporary = path.resolve(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(temporary, 'yanruyu-workspace-desktop-'));
  const data = path.join(fixture, 'data'), library = path.join(fixture, 'library');
  const env = { ...process.env, YANRUYU_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const originals = new Map();
  const errors = [];
  let application, page;
  async function launch() {
    application = await _electron.launch({ executablePath: electronExecutable(), args: [target.app, '--enable-unsafe-swiftshader'], cwd: target.folder, env, timeout: 45000 });
    page = await application.firstWindow();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
  }
  async function close() {
    if (!application) return;
    await application.evaluate(({ app }) => app.quit()).catch(() => {});
    await application.close().catch(() => {});
    application = null;
  }
  const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.ipcRenderer.invoke(channel, ...args), { channel, args });
  const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true });
  async function chooseStartPage(value) {
    await page.locator('[data-action="settings"]').click();
    await page.getByRole('combobox', { name:'启动页' }).selectOption(value);
    await page.getByRole('button', { name:'关闭设置' }).click();
  }
  const bookButton = id => page.locator(`#room [data-book="${id}"]`);
  const readPage = expected => page.waitForFunction(number => {
    const image = document.querySelector(`.paged-sheet[data-reader-page="${number}"] img`);
    return document.querySelector('#reader-page')?.textContent === `${number} / 6` && image?.naturalWidth > 0;
  }, expected);
  const closeReader = () => page.locator('[data-action="exit-reader"]').click();
  const db = file => open({ filename: path.join(data, file), driver: Database });
  try {
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'setting.json'), JSON.stringify({ library:'', hideTitleBar:true, loadOnStart:false,
      autoCheckUpdates:false, enabledLANBrowsing:false, closeToTray:false, minimizeOnStart:false }));
    for (let volume = 1; volume <= 14; volume++) {
      const folder = path.join(library, 'Neutral geometry ' + String(volume).padStart(2, '0'));
      fs.mkdirSync(folder, { recursive: true });
      for (let index = 1; index <= 6; index++) {
        const filename = path.join(folder, `${index}.png`);
        // Volumes 13 and 14 are distinct sources with identical page content.
        await sharp({ create: { width: 90, height: 130, channels: 3, background: { r: 15 * Math.min(volume, 13), g: 18 * index, b: 120 } } }).png().toFile(filename);
        originals.set(filename, sha256(filename));
      }
    }
    await launch();
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), path.join(data, '.reading-room'));
    await application.evaluate(({ app, BrowserWindow, dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send.bind(contents);
      contents.send = (channel, ...args) => {
        if (channel === 'library-updated' && args[0]?.kind === 'scan') {
          contents.send = send;
          const fs = process.getBuiltinModule('fs/promises');
          const readdir = fs.readdir;
          fs.readdir = async function(folder, ...options) {
            if (String(folder).startsWith(selected + process.getBuiltinModule('path').sep)) {
              fs.readdir = readdir;
              await new Promise(resolve => { app.releaseScanFixture = resolve; });
            }
            return readdir(folder, ...options);
          };
        }
        return send(channel, ...args);
      };
    }, library);
    await page.locator('[data-action="settings"]').click();
    await page.getByRole('button', { name: '启用 2.0 预览' }).click();
    await page.locator('#reading-desk').getByRole('button', { name: '选择书库文件夹' }).click();
    await page.locator('[data-desk-book]').first().waitFor();
    const partial = await invoke('load-book-list', false);
    assert.equal(partial.length, 1);
    const firstBook = page.locator('[data-desk-book]').first();
    const id = await firstBook.getAttribute('data-read');
    const targetBook = partial[0];
    assert.equal(targetBook.id, id);
    await firstBook.press('Enter');
    await readPage(1);
    assert((await invoke('task-list')).some(task => task.kind === 'scan' && task.status === 'running'));
    await application.evaluate(({ app }) => app.releaseScanFixture());
    await page.getByLabel('阅读模式').selectOption('double');
    await page.locator('#page-slider').fill('2');
    await readPage(2);
    await closeReader();
    await page.locator('.reader').waitFor({ state: 'detached' });
    await page.waitForFunction(() => !window.YanruyuTasks.tasks.some(task => task.kind === 'scan' && task.status === 'running'));
    const books = await invoke('load-book-list', false);
    assert.equal(books.length, 14);
    console.log('PASS Enable preview, choose an isolated library, scan, open from the desk and read a double-page spread');

    // Fail exactly the second database write and retry against the same book.
    const metadata = await db('metadata.sqlite');
    try {
      await metadata.exec(`CREATE TRIGGER reject_metadata_insert BEFORE INSERT ON Metadata
        BEGIN SELECT RAISE(ABORT, 'fixture rejects metadata write'); END`);
      const main = await db('database.sqlite');
      try {
        await assert.rejects(invoke('save-book', { id, mark: true }), /fixture rejects metadata write/);
        assert.equal((await main.get('SELECT mark FROM Mangas WHERE id = ?', id)).mark, 0);
        assert.equal((await metadata.get('SELECT mark FROM Metadata WHERE hash = ?', targetBook.hash)).mark, 0);
      } finally { await main.close(); }
      await metadata.exec('DROP TRIGGER reject_metadata_insert');
      if (process.platform === 'win32') {
        const file = path.join(data, 'metadata.sqlite');
        fs.chmodSync(file, 0o444);
        try {
          await assert.rejects(invoke('save-book', { id, mark: true }), /SQLITE_(READONLY|CANTOPEN)/);
          assert.equal((await invoke('load-book-list', false)).find(book => book.id === id).mark, false);
          assert.equal((await metadata.get('SELECT mark FROM Metadata WHERE hash = ?', targetBook.hash)).mark, 0);
        } finally { fs.chmodSync(file, 0o666); }
      }
      await invoke('save-book', { id, mark: true });
      assert.equal((await metadata.get('SELECT mark FROM Metadata WHERE hash = ?', targetBook.hash)).mark, 1);
    } finally { await metadata.close(); }
    for (const book of books) await invoke('save-book', { id: book.id, tags: { language: ['neutral'] } }, ['River Studio']);
    console.log('PASS Failure during the metadata write rolls back both databases and the same edit can be retried');

    await close();
    await launch();
    assert.equal(await nav('书桌').getAttribute('aria-current'), 'page');
    await page.locator('[data-desk-resume]').click();
    await readPage(2);
    assert.equal(await page.getByLabel('阅读模式').inputValue(), 'double');
    await closeReader();
    await page.locator('.reader').waitFor({ state:'detached' });
    await page.waitForFunction(() => document.activeElement.matches('[data-desk-resume]'));
    console.log('PASS Restart returns to the desk and a single activation restores book, page, double-page mode and return focus');

    await nav('书库').click();
    await page.getByLabel('搜索书名、作者或标签').fill('River Studio');
    await page.getByLabel('书籍排序').selectOption('title');
    await page.getByRole('button', { name: '表格视图' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.library-table tbody tr').length === 12);
    const position = [...books].sort((a, b) => a.title.localeCompare(b.title)).findIndex(book => book.id === id);
    if (position >= 12) await page.getByRole('button', { name: '下一组书架' }).click();
    await bookButton(id).scrollIntoViewIfNeeded();
    await bookButton(id).press('Enter');
    const originalPosition = await page.locator('.content').evaluate(node => node.scrollTop);
    const originalPage = await page.locator('#shelf-page').inputValue();
    const mark = await page.evaluate(() => window.__workspaceTestMarker = crypto.randomUUID());
    await page.getByRole('button', { name: '在阅览室看' }).click();
    await page.waitForSelector('.scene-viewport[data-scene-state=ready]');
    assert.match(await page.locator('#room-context-label').textContent(), /River Studio/);
    assert.equal(await bookButton(id).getAttribute('data-selected'), '');
    await page.waitForFunction(bookId => document.activeElement.dataset.book === bookId, id);
    await page.locator('#room-selection [data-read]').press('Enter');
    await readPage(2);
    await page.locator('#page-slider').fill('4');
    await readPage(4);
    await closeReader();
    await page.locator('.reader').waitFor({ state:'detached' });
    await page.waitForFunction(() => document.activeElement.matches('#room-selection [data-read]'));
    await page.locator('.scene-canvas').evaluate(canvas => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await page.waitForSelector('.scene-viewport[data-scene-state=fallback]');
    assert.equal(await bookButton(id).getAttribute('data-selected'), '');
    await page.locator('#room-selection [data-in-library]').press('Enter');
    assert.equal(await nav('书库').getAttribute('aria-current'), 'page');
    assert.equal(await page.getByLabel('搜索书名、作者或标签').inputValue(), 'River Studio');
    assert.equal(await page.getByLabel('书籍排序').inputValue(), 'title');
    assert.equal(await page.locator('#shelf-page').inputValue(), originalPage);
    assert.equal(await page.locator('.content').evaluate(node => node.scrollTop), originalPosition);
    assert.equal(await bookButton(id).getAttribute('data-selected'), '');
    await page.waitForFunction(bookId => document.activeElement.dataset.book === bookId, id);
    assert.equal(await page.evaluate(() => window.__workspaceTestMarker), mark);
    console.log('PASS Search and table → real 3D room → reader → the same table query, position, selection and keyboard focus with no reload');

    await bookButton(id).press('Enter');
    await page.getByRole('button', { name: '编辑书名和作者' }).click();
    await page.getByLabel('显示书名').fill('Renamed neutral geometry');
    await page.getByLabel('作者', { exact: true }).fill('Harbor Studio');
    await page.getByRole('button', { name: '保存修改' }).click();
    await page.getByText('这本书已移出当前筛选。').waitFor();
    assert.equal(await page.getByLabel('搜索书名、作者或标签').inputValue(), 'River Studio');
    assert.equal(await bookButton(id).count(), 0);
    await page.getByRole('button', { name: '查看此书' }).press('Enter');
    await page.getByRole('heading', { name: 'Renamed neutral geometry' }).waitFor();
    const detail = page.getByRole('dialog', { name:'书籍详情' });
    assert.equal(await detail.getByRole('button', { name: 'Harbor Studio', exact:true }).count(), 1);
    assert.equal(await detail.getByRole('button', { name: 'neutral', exact:true }).count(), 1);
    await close();
    await launch();
    await page.locator('[data-desk-resume]').waitFor();
    assert.equal(await page.locator('.desk-resume h2').textContent(), 'Renamed neutral geometry');
    const reading = await invoke('load-reading-state');
    assert.deepEqual(Object.keys(reading.progress), [id]);
    assert.equal(reading.progress[id].page, 4);
    const stored = (await invoke('load-book-list', false)).find(book => book.id === id);
    assert.equal(stored.title, 'Renamed neutral geometry');
    assert.deepEqual(stored.tags, { language: ['neutral'], artist: ['Harbor Studio'] });
    assert.equal(stored.mark, true);
    await page.locator('[data-desk-resume]').press('Enter');
    await readPage(4);
    await closeReader();
    await page.locator('.reader').waitFor({ state:'detached' });
    console.log('PASS Find the edited book outside its original filter and resume page four from the same persisted reading record after restart');

    await nav('书库').click();
    const twins = books.filter(book => /Neutral geometry 1[34]$/.test(book.filepath));
    assert.equal(twins.length, 2);
    const [donor, keeper] = twins;
    await invoke('save-reading-progress', donor.id, { page:5,total:6,time:Date.now() });
    await invoke('save-reading-progress', keeper.id, { page:2,total:6,time:Date.now() });
    await page.getByLabel('搜索书名、作者或标签').fill('');
    await page.getByLabel('书籍排序').selectOption('title');
    await page.waitForFunction(() => document.querySelector('#results').textContent.includes('共 14 本'));
    const previousPage = page.getByRole('button', { name:'上一组书架' });
    if (await previousPage.isEnabled()) await previousPage.click();
    const pageSelection = page.getByRole('checkbox', { name:'选择本页全部书籍' });
    await pageSelection.check();
    assert.equal(await page.locator('[data-check-book]:checked').count(), 12);
    await pageSelection.uncheck();
    const firstRow = page.locator('[data-check-book]').first();
    await firstRow.check();
    const firstId = await firstRow.getAttribute('data-check-book');
    assert.equal(await pageSelection.evaluate(input => input.indeterminate), true);
    await page.getByRole('button', { name:'下一组书架' }).click();
    await pageSelection.check();
    const batchIds = [firstId, ...await page.locator('[data-check-book]:checked').evaluateAll(inputs => inputs.map(input => input.dataset.checkBook))];
    assert.equal(batchIds.length, 3);
    const batch = page.getByRole('button', { name:'批量编辑所选书籍' });
    await batch.click();
    const editor = page.getByRole('dialog', { name:'批量编辑所选书籍' });
    await editor.getByText('表格勾选了 3 本，当前可编辑 3 本。').waitFor();
    assert.deepEqual((await editor.locator('[data-book-id]').evaluateAll(inputs => inputs.map(input => input.dataset.bookId))).sort(), [...batchIds].sort());
    const previewCategory = async () => {
      await editor.getByText('编辑书目信息', { exact:true }).click();
      await editor.locator('[data-field-enabled="category"]').check();
      await editor.locator('[data-field="category"]').fill('Batch fixture');
      await editor.getByRole('button', { name:'预览书目信息修改' }).click();
      await editor.getByRole('heading', { name:'修改预览 · 3 本发生变化' }).waitFor();
    };
    await previewCategory();
    await page.keyboard.press('Escape');
    const categories = async () => Object.fromEntries((await invoke('load-book-list', false)).map(book => [book.id, book.category]));
    const originalCategories = Object.fromEntries(books.map(book => [book.id, book.category]));
    assert.deepEqual(await categories(), originalCategories);
    assert.equal(await page.locator('#table-selected-count').textContent(), '已选 3 本');
    assert.equal(await pageSelection.isChecked(), true);
    assert.equal(await batch.evaluate(button => button === document.activeElement), true);
    await batch.press('Enter'); await previewCategory();
    await editor.getByRole('button', { name:'确认应用修改' }).click();
    await editor.getByText('整理已保存。可以在「整理历史」撤销这次操作。').waitFor();
    assert.deepEqual(await categories(), { ...originalCategories, ...Object.fromEntries(batchIds.map(key => [key, 'Batch fixture'])) });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name:'整理历史', exact:true }).click();
    await page.getByRole('button', { name:'撤销这次整理' }).click();
    await page.getByText('已撤销本次整理，原文件与阅读档案完整保留。').waitFor();
    assert.deepEqual(await categories(), originalCategories);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name:'清空选择', exact:true }).click();
    assert.equal(await batch.isDisabled(), true);
    console.log('PASS Page selection, cross-page batch preview, cancellation, scoped edits and undo through the library table');
    const search = page.getByLabel('搜索书名、作者或标签');
    await search.fill('neutral');
    await page.waitForFunction(() => document.querySelector('#results').textContent.includes('共 14 本'));
    for (const book of twins) {
      const checkbox = page.locator(`[data-check-book="${book.id}"]`);
      if (!(await checkbox.count())) {
        const nextPage = page.getByRole('button', { name:'下一组书架' });
        if (await nextPage.isEnabled()) await nextPage.click();
        else await page.getByRole('button', { name:'上一组书架' }).click();
      }
      await checkbox.check();
      if (book.id === donor.id) {
        await bookButton(donor.id).press('Enter');
        await page.getByRole('dialog', { name:'书籍详情', exact:true }).waitFor();
        await page.keyboard.press('Escape');
      }
    }
    const compare = page.getByRole('button', { name:'对照所选书籍' });
    await compare.click();
    await page.locator('.organizer-source-grid img').first().waitFor();
    assert.equal(await page.locator('.organizer-source-grid img').count(), 2);
    await page.getByText('全部文件的完整 SHA-256 内容一致', { exact:true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#table-selected-count').textContent(), '已选 2 本');
    await compare.click();
    await page.getByRole('button', { name:'确认合并书架展示' }).waitFor();
    await page.locator('[data-keeper]').selectOption(keeper.id);
    await page.locator('[data-progress-source]').selectOption(donor.id);
    await page.getByRole('button', { name:'核对完整内容并预览合并' }).click();
    await page.getByRole('button', { name:'确认合并书架展示' }).click();
    await page.getByText('整理已保存。可以在「整理历史」撤销这次操作。').waitFor();
    const hiddenTwinCount = list => list.filter(book => twins.some(twin=>twin.id === book.id) && book.hiddenBook).length;
    assert.equal(hiddenTwinCount(await invoke('load-book-list', false)), 1);
    assert.equal((await invoke('load-reading-state')).progress[keeper.id].page, 5);
    const notice = page.locator('#filtered-book-notice');
    await notice.getByText('所选书已隐藏，原查询已保留。').waitFor({ state:'attached' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(bookId => document.activeElement.dataset.book === bookId, keeper.id);
    assert.equal(await search.inputValue(), 'neutral');
    assert.equal(await bookButton(keeper.id).getAttribute('data-selected'), '');
    assert.equal(await page.locator(`[data-check-book="${keeper.id}"]`).isChecked(), true);
    await close(); await launch(); await nav('书库').click();
    await page.getByRole('button', { name:'整理历史', exact:true }).click();
    await page.getByRole('button', { name:'撤销这次整理' }).click();
    await page.getByText('已撤销本次整理，原文件与阅读档案完整保留。').waitFor();
    assert.equal(hiddenTwinCount(await invoke('load-book-list', false)), 0);
    const restoredProgress = (await invoke('load-reading-state')).progress;
    assert.equal(restoredProgress[keeper.id].page, 2);
    assert.equal(restoredProgress[donor.id].page, 5);
    await page.keyboard.press('Escape');
    console.log('PASS Compare both copies, cancel with the same selection, merge, restart, and undo from table history');

    const progressBeforeRefresh = (await invoke('load-reading-state')).progress[id];
    const pick = path.join(fixture, 'hand-picked.png');
    fs.copyFileSync(path.join(targetBook.filepath, '2.png'), pick);
    const customCover = await invoke('use-new-cover', pick);
    assert.match(path.basename(customCover), /^custom-/);
    await invoke('save-book', { id, coverPath: customCover });
    const coverDigest = sha256(customCover);
    const appended = path.join(targetBook.filepath, '7.png');
    fs.copyFileSync(pick, appended);
    originals.set(appended, sha256(appended));
    const exclusion = path.basename(targetBook.filepath) + '$';
    await invoke('save-library-exclusion', exclusion);
    await page.getByLabel('搜索书名、作者或标签').fill('Renamed neutral geometry');
    await bookButton(id).press('Enter');
    const refreshDetail = page.getByRole('dialog', { name:'书籍详情' });
    const refresh = refreshDetail.getByRole('button', { name:'刷新本地页数与封面' });
    await refresh.click();
    await refreshDetail.getByText('书籍被扫描排除规则排除，可以在设置中调整规则').waitFor();
    await assert.rejects(invoke('patch-local-metadata-by-book', { id }), /扫描排除规则/);
    assert.equal((await invoke('load-book-list', false)).find(book => book.id === id).pageCount, 6);
    assert((await invoke('task-list')).some(task => task.kind === 'metadata' && task.errors.some(error => error.bookId === id)));
    await refreshDetail.getByRole('button', { name:'调整扫描排除规则' }).click();
    const pattern = page.getByLabel('排除路径正则表达式');
    await pattern.fill('[');
    await page.getByRole('button', { name:'保存规则' }).click();
    await page.getByText('书库排除规则不是有效的正则表达式', { exact:true }).waitFor();
    assert.equal((await invoke('load-setting')).excludeFile, exclusion);
    await pattern.fill('');
    await page.getByRole('button', { name:'保存规则' }).click();
    await page.getByText('规则已保存，下次刷新或扫描时生效。').waitFor();
    await page.getByRole('button', { name:'关闭设置' }).click();
    await bookButton(id).press('Enter');
    await refresh.click();
    await refreshDetail.getByText('刷新完成，共 7 页。').waitFor();
    const refreshed = (await invoke('load-book-list', false)).find(book => book.id === id);
    assert.equal(refreshed.coverPath, customCover);
    assert.equal(sha256(customCover), coverDigest);
    const parked = path.join(library, 'Relocated neutral geometry');
    fs.renameSync(targetBook.filepath, parked);
    for (const [filename, digest] of [...originals]) if (path.dirname(filename) === targetBook.filepath) {
      originals.delete(filename);
      originals.set(path.join(parked, path.basename(filename)), digest);
    }
    await refresh.click();
    await refreshDetail.getByText('书籍文件或文件夹已缺失，可以重新定位原文件').waitFor();
    await application.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }, parked);
    await refreshDetail.getByRole('button', { name:'重新定位文件' }).click();
    await refreshDetail.getByText(parked, { exact:true }).waitFor();
    await close(); await launch();
    const relocated = (await invoke('load-book-list', false)).find(book => book.id === id);
    assert.equal(relocated.coverPath, customCover);
    assert.equal(relocated.filepath, parked);
    assert.equal(relocated.pageCount, 7);
    assert.deepEqual((await invoke('load-reading-state')).progress[id], progressBeforeRefresh);
    assert.equal(sha256(customCover), coverDigest);
    console.log('PASS Report exclusion and missing source, correct the rule, refresh and relocate with the same custom cover and reading progress after restart');

    await nav('书库').click();
    await bookButton(id).click();
    await page.getByRole('button', { name:'加入精选陈列' }).click();
    await page.keyboard.press('Escape');
    await page.getByLabel('搜索书名、作者或标签').fill('River Studio');
    await page.waitForFunction(() => document.querySelector('#results').textContent.includes('共 13 本'));
    await chooseStartPage('library');
    await nav('书桌').click();
    await close(); await launch();
    await page.locator('.library-table tbody tr').first().waitFor();
    assert.equal(await nav('书库').getAttribute('aria-current'), 'page');
    assert.equal(await page.getByLabel('搜索书名、作者或标签').inputValue(), 'River Studio');
    await chooseStartPage('room');
    assert.equal(await nav('书库').getAttribute('aria-current'), 'page');
    await close(); await launch();
    await page.waitForSelector('.scene-viewport[data-scene-state=ready]');
    assert.equal(await nav('阅览室').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#room-context-label').textContent(), '精选陈列');
    assert.equal(await page.locator('#room [data-book]').count(), 1);
    assert.equal(await bookButton(id).count(), 1);
    await nav('书库').click();
    assert.equal(await page.getByLabel('搜索书名、作者或标签').inputValue(), 'River Studio');
    assert.equal(await bookButton(id).count(), 0);
    console.log('PASS Restart opens the chosen filtered table or featured room independently of the last active workspace');

    const missing = books.find(book => book.id !== id && !twins.includes(book));
    const parkedMissing = path.join(fixture, 'offline-book');
    fs.renameSync(missing.filepath, parkedMissing);
    const rescanned = await invoke('load-book-list', true);
    assert.equal(rescanned.find(book => book.id === missing.id).exist, false);
    const removalSearch = page.getByLabel('搜索书名、作者或标签');
    const removalNotice = page.locator('#filtered-book-notice');
    await removalSearch.fill(missing.title);
    await page.waitForFunction(() => document.querySelector('#results').textContent.includes('共 1 本'));
    await page.waitForFunction(bookId => document.querySelector(`#room [data-book="${bookId}"]`)?.closest('tr')?.textContent.includes('失联'), missing.id);
    await bookButton(missing.id).press('Enter');
    await page.getByRole('button', { name:'检查与移除失联记录' }).click();
    await page.getByRole('button', { name:'删除所选记录' }).click();
    await page.getByRole('button', { name:'确认删除 1 本记录' }).click();
    await removalNotice.getByText('所选书已从书库移除，原查询已保留。').waitFor({ state:'attached' });
    await page.keyboard.press('Escape');
    const emptyAction = page.locator('#room').getByRole('button', { name:'查看全部藏书' });
    await page.waitForFunction(() => document.activeElement.matches('#room .empty button'), null, { timeout:5000 }).catch(async error => {
      const focused = await page.evaluate(() => document.activeElement.cloneNode(false).outerHTML);
      throw new Error(`Expected keyboard focus on the empty-results action. Focused element: ${focused}`, { cause:error });
    });
    assert.equal(await emptyAction.isVisible(), true);
    assert.equal(await removalSearch.inputValue(), missing.title);
    assert.equal((await invoke('load-book-list', false)).some(book => book.id === missing.id), false);
    await page.getByRole('button', { name:'整理历史', exact:true }).click();
    await page.getByRole('button', { name:'恢复删除的书库记录' }).click();
    await bookButton(missing.id).waitFor({ state:'attached' });
    await page.keyboard.press('Escape');
    assert.equal(await removalNotice.isVisible(), false);
    fs.renameSync(parkedMissing, missing.filepath);
    console.log('PASS Lost selection after real organizer merge and removal preserves the query, restores keyboard focus, and recovers the record through history');

    await page.locator('[data-action="settings"]').click();
    await page.getByRole('button', { name: '返回原界面' }).click();
    await close(); await launch();
    await page.locator('[data-action="classic"]').waitFor();
    assert.equal(await page.locator('.workspace-nav').isVisible(), false);
    assert.equal(await page.locator('[data-action="classic"]').isVisible(), true);
    for (const [filename, digest] of originals) assert.equal(sha256(filename), digest);
    assert.deepEqual(errors, []);
    console.log('PASS Preview can be disabled, all original image hashes are intact, and the renderer reports no uncaught errors');
  } catch (error) {
    if (page && !page.isClosed()) {
      const output = path.join(root, 'tools', '.artifacts', 'workspace-desktop');
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'failed.png') }).catch(() => {});
      fs.writeFileSync(path.join(output, 'failed.html'), await page.content().catch(() => 'unavailable'));
    }
    throw error;
  } finally {
    await close();
    const target = fs.realpathSync(fixture);
    if (path.dirname(target) !== fs.realpathSync(temporary) || !path.basename(target).startsWith('yanruyu-workspace-desktop-')) {
      throw new Error('Unsafe workspace fixture cleanup');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
