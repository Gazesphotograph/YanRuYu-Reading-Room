'use strict';

const { fs, path, root, runNode } = require('./common.cjs');
const { build } = require('./build.cjs');

try {
  // Fresh checkouts have no dependencies beside resources/app. Make the locked
  // runtime available to test child processes without modifying a live install.
  const built = build();
  process.env.NODE_PATH = [path.join(built.app, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  process.env.YANRUYU_TEST_BUILD = built.folder;
  runNode('--test', [path.join(root, 'tools', 'tests', 'engineering.test.cjs')]);
  const all = process.argv.includes('--all');
  const candidates = fs.readdirSync(path.join(root, 'tools')).filter(file => /^test-.*\.cjs$/.test(file)).sort();
  const selected = candidates.filter(file => {
    // This historic test reads a real library and is intentionally excluded.
    if (file === 'test-desktop-gallery.cjs') return false;
    if (all) return true;
    return file === 'test-gallery.cjs' || file === 'test-ui-theme-consistency.cjs' || /phase1|phase2|phase3|phase-one|backup|data-protection|raw-recovery|client-state|reading-|reader-tools|smart-shelves|scene-budget|cache-budget|task-center|incremental-scan|safe-operations|import|isolated-desktop|startup-tray|security-performance|organizer|local-search|windows-ocr|room-personalization/.test(file);
  });
  for (const file of selected) runNode(path.join(root, 'tools', file));
  console.log(`Test suites passed: engineering + ${selected.length} ${all ? 'full regression' : 'project regression'} suites.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
