'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { assertWithin, isWithin } = require('./safety')

async function moveWithoutReplacing(source, destination, libraryRoot) {
  if (!isWithin(libraryRoot, source) || !isWithin(libraryRoot, destination)) throw new Error('移动路径需要位于当前书库内')
  await assertWithin(libraryRoot, source)
  await assertWithin(libraryRoot, path.dirname(destination), true)
  if (process.platform !== 'win32') {
    // link creates a file name exclusively, unlike rename's replacement mode.
    const stat = await fs.promises.lstat(source)
    if (stat.isFile()) { await fs.promises.link(source, destination); await fs.promises.unlink(source); return }
    try { await fs.promises.lstat(destination); throw new Error('目标路径已存在，移动未执行') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    return fs.promises.rename(source, destination)
  }
  // Node's Windows rename enables MOVEFILE_REPLACE_EXISTING. File.Move and
  // Directory.Move use the OS operation that refuses an occupied destination.
  // Paths travel as JSON on stdin and never become PowerShell command text.
  const script = await fs.promises.readFile(path.join(__dirname, 'exclusive_move.ps1'), 'utf8')
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide:true, timeout:30000, maxBuffer:65536, encoding:'utf8' }, (error, stdout) => {
        let result
        try { result = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) } catch {}
        if (!error && result?.success) { resolve(); return }
        const failed = new Error([80,183].includes(result?.nativeCode) ? '目标路径已存在，移动未执行' : '文件移动未完成，来源与已有目标均保留')
        failed.code = [80,183].includes(result?.nativeCode) ? 'EEXIST' : 'ERR_BOOK_MOVE'
        reject(failed)
      })
    child.stdin.on('error', () => {}) // execFile's callback reports a failed helper.
    child.stdin.end(JSON.stringify({ source:path.resolve(source), destination:path.resolve(destination), libraryRoot:path.resolve(libraryRoot) }))
  })
}

module.exports = { moveWithoutReplacing }
