'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getWindowsOcrCapability, recognizeWindowsImage, OCR_LIMITS } = require('../resources/app/modules/windows_ocr');
const run = promisify(execFile);

async function main() {
  const capability = await getWindowsOcrCapability();
  assert.equal(typeof capability.available, 'boolean'); assert(Array.isArray(capability.languages));
  if (!capability.available) { console.log('SKIP native OCR sample: ' + capability.reason); return; }
  const english = capability.languages.find(item => item.tag.startsWith('en'));
  if (!english) { console.log('SKIP neutral English OCR sample: no English OCR language installed; available: ' + capability.languages.map(item => item.tag).join(', ')); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-local-search-ocr-'));
  try {
    const sample = path.join(directory, 'neutral OCR & sample.png');
    const script = path.join(directory, 'draw-neutral-sample.ps1');
    await fs.writeFile(script, `param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(3000, 640)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = New-Object System.Drawing.Font('Segoe UI', 72)
try {
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.DrawString('FOREST NOTES', $font, [System.Drawing.Brushes]::Black, 140, 80)
  $graphics.DrawString('Quiet garden sunlight', $font, [System.Drawing.Brushes]::Black, 140, 260)
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
`, 'utf8');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await run(powershell, ['-NoProfile', '-NonInteractive', '-File', script, '-OutputPath', sample], { windowsHide: true, timeout: 15000 });
    const result = await recognizeWindowsImage(sample, { language: english.tag });
    assert.match(result.text.toLowerCase(), /forest\s+notes/); assert.match(result.text.toLowerCase(), /garden\s+sunlight/);
    assert.equal(result.source, 'windows-ocr'); assert.equal(result.language, english.tag);
    assert.equal(result.sourceWidth, 3000); assert(result.width <= OCR_LIMITS.longestSide); assert(result.elapsedMilliseconds >= 0);
    console.log('PASS installed Windows OCR recognizes a neutral sample, preserves language and bounds raster dimensions');
    await assert.rejects(recognizeWindowsImage(sample, { language: 'not-installed' }), /没有安装/);
    await assert.rejects(recognizeWindowsImage(script), /请选择/);
    const oversized = path.join(directory, 'oversized.png');
    const handle = await fs.open(oversized, 'w'); await handle.truncate(OCR_LIMITS.imageBytes + 1); await handle.close();
    await assert.rejects(recognizeWindowsImage(oversized), /20 MiB/);
    console.log('PASS unknown OCR languages, non-images and oversized inputs are refused before recognition');
    console.log(JSON.stringify({ suite: 'native-windows-ocr', installedLanguages: capability.languages.map(item => item.tag), recognizedCharacters: result.text.length,
      originalWidth: result.sourceWidth, processedWidth: result.width, elapsedMilliseconds: result.elapsedMilliseconds, downloadBytes: 0 }));
  } finally {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('yanruyu-local-search-ocr-')) throw new Error('Refusing cleanup outside the OCR fixture');
    await fs.rm(target, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
