'use strict';

// Run against an unpacked Windows release. Every measured launch uses the same
// synthetic profile on the temp volume. No OS disk cache is evicted.
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { fs, path, root, sha256, electronExecutable } = require('./project/common.cjs');
const { _electron } = require('./playwright-runtime.cjs');

const distinctCover = { width: 240, height: 360, sampleWidth: 60, sampleHeight: 90, format: 'webp' };
const fixtureId = n => 'fixture-' + String(n).padStart(5, '0');
const coverFile = (directory, id) => path.join(directory, id + '.' + distinctCover.format);

async function writeDistinctCovers(directory, from, to, sharp) {
  const { width, height, sampleWidth, sampleHeight } = distinctCover;
  let bytes = 0;
  fs.mkdirSync(directory, { recursive: true });
  for (let offset = from; offset < to; offset += 12) {
    const covers = await Promise.all(Array.from({ length: Math.min(12, to - offset) }, (_, i) => {
      const index = offset + i;
      const pixels = Buffer.allocUnsafe(sampleWidth * sampleHeight * 3);
      let random = index;
      for (let y = 0; y < sampleHeight; y++) {
        for (let x = 0; x < sampleWidth; x++) {
          const start = (y * sampleWidth + x) * 3;
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          pixels[start] = (index + 3 * x + y + (random >>> 29)) & 255;
          pixels[start + 1] = ((index >>> 5) + 2 * y + ((random >>> 25) & 7)) & 255;
          pixels[start + 2] = (4 * x + (y < sampleHeight / 2 ? 40 : 100) + ((random >>> 21) & 7)) & 255;
        }
      }
      pixels.writeUIntBE(index, 0, 3);
      return sharp(pixels, { raw: { width: sampleWidth, height: sampleHeight, channels: 3 } })
        .resize(width, height, { kernel: 'nearest' }).webp({ lossless: true, effort: 0 })
        .toFile(coverFile(directory, fixtureId(index)));
    }));
    for (const cover of covers) bytes += cover.size;
  }
  return bytes;
}

async function sampleCoverGrid(page) {
  await page.locator('#search').fill('');
  await page.waitForFunction(() => document.querySelectorAll('.library-table [data-book]').length === 12);
  return page.evaluate(async () => {
    const times = [];
    const coversPerSample = 6;
    let previousFirstBook;
    for (let step = 0; step <= 20; step++) {
      const trigger = document.querySelector(step ? '[data-action="next"]' : '[data-view="grid"]');
      if (!trigger || trigger.disabled) throw new Error('Cannot advance the cover grid');
      const start = performance.now();
      trigger.click();
      while (true) {
        const first = document.querySelector('.book-grid [data-book]')?.dataset.book;
        const images = [...document.querySelectorAll('.book-grid [data-book] img')].slice(0, coversPerSample);
        if (first && first !== previousFirstBook && images.length === coversPerSample &&
            images.every(img => img.complete && img.naturalWidth > 0)) {
          previousFirstBook = first;
          break;
        }
        if (performance.now() - start > 5000) throw new Error('Cover grid decode timed out');
        await new Promise(requestAnimationFrame);
      }
      await new Promise(requestAnimationFrame);
      times.push(performance.now() - start);
    }
    return { entryMs: times[0], pageMs: times.slice(1), coversPerSample };
  });
}

async function benchmark(folder) {
  const packaged = fs.existsSync(path.join(folder, 'exhentai-manga-manager.exe'));
  const executable = packaged ? path.join(folder, 'exhentai-manga-manager.exe') : electronExecutable();
  const workspace = process.argv.includes('--workspace');
  const distinctCovers = process.argv.includes('--distinct-covers');
  if (distinctCovers && !workspace) throw new Error('Distinct-cover sampling requires --workspace.');
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'build-manifest.json'), 'utf8'));
  const sharp = require(path.join(folder, 'resources/app/node_modules/sharp'));
  const temp = fs.realpathSync.native(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(temp, 'yanruyu-library-bench-'));
  const data = path.join(scratch, 'data'), library = path.join(scratch, 'library');
  const coverDirectory = path.join(data, 'cover');
  const realBook = path.join(library, 'Benchmark reader');
  const env = { ...process.env, YANRUYU_DATA_DIR:data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, page;
  const launch = async () => {
    app = await _electron.launch({ executablePath:executable, args:packaged?[]:[path.join(folder,'resources','app')], cwd:folder, env, timeout:60000 });
    page = await app.firstWindow();
  };
  const close = async () => {
    if (!app) return;
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
    app = null;
  };
  const profile = { version:manifest.appVersion, view:workspace?'2.0-library-table':'original-grid', executableSha256:sha256(executable), sourceHashes:manifest.sourceHashes, cpu:os.cpus()[0].model,
    coverMode: distinctCovers ? 'distinct' : 'shared', osDiskCacheEvicted: false,
    memoryGiB:Math.round(os.totalmem()/2**30), platform:os.release(), tempVolume:path.parse(scratch).root, samples:[] };
  const output = path.join(root, 'tools', '.artifacts', 'library-benchmark');
  fs.mkdirSync(output, { recursive:true });
  const report = path.join(output, `results-${Date.now()}.json`);
  const p95 = values => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
  try {
    fs.mkdirSync(data);
    fs.mkdirSync(realBook, { recursive:true });
    for (let n=1; n<=4; n++) {
      await sharp({ create:{ width:1000,height:1400,channels:3,background:{r:40*n,g:90,b:160} } }).png().toFile(path.join(realBook,`${n}.png`));
    }
    fs.writeFileSync(path.join(data,'setting.json'), JSON.stringify({ library, loadOnStart:false, autoCheckUpdates:false, closeToTray:false, minimizeOnStart:false, enabledLANBrowsing:false }));
    await launch();
    await page.waitForSelector('[data-view="grid"]');
    const [seed] = await page.evaluate(()=>window.ipcRenderer.invoke('load-book-list',true));
    await page.locator('[data-view="grid"]').click();
    if(workspace) {
      await page.evaluate(()=>{
        localStorage.setItem('room-workspace-preview','true');
        localStorage.setItem('room-workspace-start-page',JSON.stringify('library'));
        localStorage.setItem('room-workspace-library-view',JSON.stringify('table'));
      });
      await page.reload();
      await page.getByRole('table',{name:'书库结果'}).waitFor();
    }
    await page.evaluate(()=>window.YanruyuClientState.flush());
    profile.display = await page.evaluate(()=>({ width:innerWidth,height:innerHeight,devicePixelRatio }));
    profile.gpu = await app.evaluate(async ({ app })=>(await app.getGPUInfo('basic')).gpuDevice.map(g=>({ vendorId:g.vendorId, deviceId:g.deviceId, active:g.active })));
    await close();
    let previous = 1, coverBytes = 0;
    for (const count of [10000,30000]) {
      if (distinctCovers) {
        console.log(`Generating ${count - previous} distinct WebP covers for ${count} rows.`);
        coverBytes += await writeDistinctCovers(coverDirectory, previous, count, sharp);
      }
      const db = new DatabaseSync(path.join(data,'database.sqlite'));
      try {
        db.prepare('ATTACH DATABASE ? AS metadata_db').run(path.join(data,'metadata.sqlite'));
        db.exec('BEGIN');
        const row = db.prepare('INSERT INTO Mangas (id,title,type,filepath,hash,coverPath,status,pageCount,tags,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
        const metadata = db.prepare('INSERT INTO metadata_db.Metadata (hash,title,status,tags,createdAt,updatedAt) VALUES (?,?,?,?,?,?)');
        const timestamp = new Date(seed.createdAt).toISOString();
        for (let n=previous; n<count; n++) {
          const id = fixtureId(n), tags = JSON.stringify({ artist:['Studio '+(n%200)], other:['Geometry'] });
          const cover = distinctCovers ? coverFile(coverDirectory, id) : seed.coverPath;
          row.run(id,id,'folder',path.join(library,id),id,cover,'tagged',4,tags,timestamp,timestamp);
          metadata.run(id,id,'tagged',tags,timestamp,timestamp);
        }
        db.exec('COMMIT');
      } finally { db.close(); }
      previous = count;
      const samples = { count, launchMs:[], searchMs:[], turnMs:[] };
      if (distinctCovers) samples.coverFixture = { ...distinctCover, files: count - 1, bytes: coverBytes };
      for (let i=0; i<30; i++) {
        const start = performance.now();
        await launch();
        await page.waitForSelector('#room [data-book]');
        await page.evaluate(async () => {
          const button = document.querySelector('#room [data-book]');
          button.focus();
          if (document.activeElement !== button) throw Error('First book is not interactive');
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        });
        samples.launchMs.push(performance.now()-start);
        if (i<29) await close();
        if ((i+1)%10===0) console.log(`${count} rows: ${i+1}/30 launches`);
      }
      samples.searchMs = await page.evaluate(async count => {
        const input = document.querySelector('#search'), times = [];
        for (let i=1; i<=100; i++) {
          const id = 'fixture-'+String(1+(i*97)%(count-1)).padStart(5,'0');
          const start = performance.now();
          input.value=id; input.dispatchEvent(new Event('input',{bubbles:true}));
          while (document.querySelector('#room [data-book]')?.dataset.book !== id) {
            if (performance.now()-start>5000) throw Error('Catalogue search timed out');
            await new Promise(requestAnimationFrame);
          }
          await new Promise(requestAnimationFrame);
          times.push(performance.now()-start);
        }
        return times;
      }, count);
      if (distinctCovers) {
        samples.coverGrid = await sampleCoverGrid(page);
        samples.coverGrid.pageP95Ms = p95(samples.coverGrid.pageMs);
        await page.locator('[data-view="table"]').click();
      }
      await page.locator('#search').fill('Benchmark reader');
      await page.locator(`#room [data-book="${seed.id}"]`).dblclick();
      await page.waitForSelector('.reader-body img');
      samples.turnMs = await page.evaluate(async () => {
        const slider = document.querySelector('#page-slider'), times=[];
        for (let i=0; i<102; i++) {
          const num = i%2+1, start = performance.now();
          slider.value=num; slider.dispatchEvent(new Event('input',{bubbles:true}));
          while (document.querySelector('#reader-page')?.textContent !== `${num} / 4` ||
                 !document.querySelector(`[data-reader-page="${num}"] img`)?.naturalWidth) {
            if (performance.now()-start>5000) throw Error('Page flip timed out');
            await new Promise(requestAnimationFrame);
          }
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          if (i>=2) times.push(performance.now()-start);
        }
        return times;
      });
      samples.p95Ms = { launch:p95(samples.launchMs), search:p95(samples.searchMs), turn:p95(samples.turnMs) };
      profile.samples.push(samples);
      fs.writeFileSync(report, JSON.stringify(profile,null,2));
      console.log(count, samples.p95Ms, report);
      await page.locator('[data-action="exit-reader"]').click();
      await page.locator('.reader').waitFor({ state:'detached' });
      await page.locator('#search').fill('');
      await page.waitForFunction(()=>document.querySelectorAll('#room [data-book]').length===12);
      await page.evaluate(()=>window.YanruyuClientState.flush());
      await close();
    }
  } finally {
    await close();
    const resolved = fs.realpathSync.native(scratch);
    if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('yanruyu-library-bench-')) throw Error('Unexpected fixture path');
    await fs.promises.rm(resolved,{ recursive:true,force:true,maxRetries:6,retryDelay:150 });
  }
}
if (!process.argv[2]) throw Error('Provide the unpacked Windows release directory to measure.');
benchmark(path.resolve(process.argv[2])).catch(error=>{ console.error(error); process.exitCode=1; });
