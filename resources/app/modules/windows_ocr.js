'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const LIMITS = Object.freeze({ imageBytes: 20 * 1024 * 1024, pixels: 40000000, longestSide: 2600, timeoutMilliseconds: 35000 })
let cachedCapability, capabilityPromise

function runPowerShell(mode, args = []) {
  if (process.platform !== 'win32') return Promise.resolve({ available: false, reason: '系统图片识别仅在 Windows 10 / 11 上可用，可手动导入文本。', languages: [] })
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    // Only fixed flags and separate arguments reach PowerShell; chosen paths
    // are never interpolated into executable script text.
    execFile(executable, ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'windows_ocr.ps1'), '-Mode', mode, ...args],
      { windowsHide: true, timeout: LIMITS.timeoutMilliseconds, maxBuffer: 512 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          if (error.killed) return reject(new Error('系统 OCR 超过 35 秒，已停止。请改用较小的图片或手动粘贴文本。'))
          return reject(new Error(`无法运行 Windows 系统 OCR：${String(stderr || error.message).trim().slice(0, 500)}`))
        }
        let result
        try { result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) } catch { return reject(new Error('Windows 系统 OCR 返回了无法读取的结果')) }
        if (result.error) return reject(new Error(String(result.error)))
        resolve(result)
      })
  })
}

async function getWindowsOcrCapability({ refresh = false } = {}) {
  if (cachedCapability && !refresh) return { ...cachedCapability, limits: LIMITS }
  if (capabilityPromise) return capabilityPromise
  capabilityPromise = runPowerShell('capability').catch(error => ({ available: false, reason: error.message, languages: [] }))
    .then(result => { cachedCapability = { ...result, limits: LIMITS }; return cachedCapability })
    .finally(() => { capabilityPromise = null })
  return capabilityPromise
}

async function recognizeWindowsImage(filepath, { language = '' } = {}) {
  if (typeof filepath !== 'string' || !path.isAbsolute(filepath) || /[\x00\r\n]/.test(filepath) || !/\.(png|jpe?g|bmp|tiff?)$/i.test(filepath)) throw new Error('请选择本地 PNG、JPEG、BMP 或 TIFF 图片')
  if (typeof language !== 'string' || !/^[a-zA-Z0-9-]{0,35}$/.test(language)) throw new Error('OCR 语言无效')
  const stat = await fs.promises.lstat(filepath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.imageBytes || stat.size === 0) throw new Error('OCR 仅接受不超过 20 MiB 的普通本地图片')
  // Network shares are deliberately excluded: selected content stays on disk
  // and the OCR operation must not become an implicit network read.
  if (/^(\\\\|\/\/)/.test(filepath)) throw new Error('请先把图片保存在本机磁盘，再进行 OCR')
  const capability = await getWindowsOcrCapability()
  if (!capability.available) throw new Error(capability.reason || '此系统尚无可用的 OCR 语言')
  if (language && !capability.languages.some(item => item.tag === language)) throw new Error('所选 OCR 语言没有安装在此 Windows 系统中')
  const result = await runPowerShell('recognize', ['-ImagePath', path.resolve(filepath), ...(language ? ['-Language', language] : [])])
  if (typeof result.text !== 'string' || result.text.length > 30000) throw new Error('识别文字超过单页 30000 字符限制，请裁剪图片后重试')
  return { ...result, source: 'windows-ocr' }
}

module.exports = { getWindowsOcrCapability, recognizeWindowsImage, OCR_LIMITS: LIMITS }
