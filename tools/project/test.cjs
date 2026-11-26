'use strict';

const { fs, path, root, runNode } = require('./common.cjs');
const { build } = require('./build.cjs');
const { buildUi } = require('./build-ui.cjs');

function test() {
  if (!process.argv.includes('--all')) {
    // The suites open resources/app/dist/index.html directly; it needs the bundle.
    buildUi();
    runNode(path.join(root, 'tools', 'test-workspace-smoke.cjs'));
    return;
  }
  // Fresh checkouts have no dependencies beside resources/app. Make the locked
  // runtime available to test child processes without modifying a live install.
  const built = build();
  process.env.NODE_PATH = [path.join(built.app, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  process.env.YANRUYU_TEST_BUILD = built.folder;
  const suites = [];
  const runSuite = (name, callback) => {
    const started = Date.now();
    console.log('RUN ' + name);
    try { callback(); suites.push({ name, status:'passed', durationMs:Date.now()-started }); }
    catch (error) { suites.push({ name, status:'failed', durationMs:Date.now()-started, error:error.message }); console.error('FAIL ' + name + ': ' + error.message); }
  };
  runSuite('engineering', () => runNode('--test', [path.join(root, 'tools', 'tests', 'engineering.test.cjs')]));
  const candidates = fs.readdirSync(path.join(root, 'tools')).filter(file => /^test-.*\.cjs$/.test(file)).sort();
  // The historic desktop gallery test reads a real library.
  const selected = candidates.filter(file => file !== 'test-desktop-gallery.cjs');
  for (const file of selected) runSuite(file, () => runNode(path.join(root, 'tools', file)));
  const reportFolder = path.join(root, 'tools', '.artifacts', 'full-regression');
  fs.mkdirSync(reportFolder, { recursive:true });
  const failed = suites.filter(suite => suite.status === 'failed');
  fs.writeFileSync(path.join(reportFolder, 'results.json'), JSON.stringify({ date:new Date().toISOString(),
    build:built.folder, sourceHashes:built.manifest.sourceHashes, passed:suites.length-failed.length, failed:failed.length, suites }, null, 2));
  if (failed.length) throw new Error(`${failed.length} suites failed: ${failed.map(suite=>suite.name).join(', ')}. Full report: ${path.join(reportFolder,'results.json')}`);
  console.log(`Test suites passed: engineering + ${selected.length} full regression suites.`);
}

try { test(); } catch (error) { console.error(error.message); process.exitCode = 1; }
