const fs = require('fs')
const path = require('path')
const { glob } = require('glob')
const { nanoid } = require('nanoid')
const { spawnPromise } = require('../modules/process_runner')
const { safeEntry } = require('../modules/safety')
const { editArchiveSafely } = require('../modules/archive_recovery')
const { getArchiveCache, sourceKey, checkCancelled } = require('../modules/archive_cache')
const { getRootPath } = require('../modules/utils.js')

const _7z = path.join(getRootPath(), 'resources/extraResources/7z.exe')

const getArchivelist = async (libraryPath, options = {}) => {
  checkCancelled(options.signal)
  const list = await glob('**/*.@(rar|7z|cb7|cbr)', {
    cwd: libraryPath,
    nocase: true,
    nodir: true,
    follow: false,
    absolute: true,
    signal: options.signal
  })
  checkCancelled(options.signal)
  return list
}

const solveBookTypeArchive = async (filepath, TEMP_PATH, COVER_PATH, options = {}) => {
  checkCancelled(options.signal)
  const tempFolder = path.join(TEMP_PATH, nanoid(8))
  const imageList = await listArchiveImages(filepath, options)

  let targetFile
  let targetFilePath
  let coverFile
  let tempCoverPath
  let coverPath
  if (imageList.length > 8) {
    targetFile = imageList[7]
    coverFile = imageList[0]
    await spawnPromise(_7z, ['x', '-y', '-spd', '-bso0', '-bsp0', '-o'+tempFolder, '-p123456', '--', filepath, targetFile], 120000, options)
    await spawnPromise(_7z, ['x', '-y', '-spd', '-bso0', '-bsp0', '-o'+tempFolder, '-p123456', '--', filepath, coverFile], 120000, options)
  } else if (imageList.length > 0) {
    targetFile = imageList[0]
    coverFile = imageList[0]
    await spawnPromise(_7z, ['x', '-y', '-spd', '-bso0', '-bsp0', '-o'+tempFolder, '-p123456', '--', filepath, targetFile], 120000, options)
  } else {
    throw new Error('compression package isnot include image')
  }
  checkCancelled(options.signal)
  targetFilePath = path.join(TEMP_PATH, nanoid(8) + path.extname(targetFile))
  await fs.promises.copyFile(path.join(tempFolder, targetFile), targetFilePath)

  tempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(coverFile))
  await fs.promises.copyFile(path.join(tempFolder, coverFile), tempCoverPath)

  coverPath = path.join(COVER_PATH, nanoid() + '.webp')

  const fileStat = await fs.promises.stat(filepath)
  return {targetFilePath, tempCoverPath, coverPath, pageCount: imageList.length, bundleSize: fileStat?.size, mtime: fileStat?.mtime}
}

const getImageListFromArchive = async (filepath, VIEWER_PATH, options = {}) => {
  checkCancelled(options.signal)
  const stat = await fs.promises.stat(filepath)
  const key = sourceKey(filepath, stat)
  return getArchiveCache(VIEWER_PATH).getOrCreate({
    key, filepath, ...options,
    inspect: async signal => {
      const listing = await archiveListing(filepath, { signal })
      const names = validateArchiveListing(listing)
      const images = new Set(names)
      const expandedBytes = archiveFields(listing).filter(fields=>images.has(fields.Path)).reduce((sum,fields)=>sum+Number(fields.Size||0),0)
      return { names, expandedBytes }
    },
    extract: async (directory, info, signal, onProgress) => {
      const selectionFile = path.join(directory, '.manager-selection.txt')
      await fs.promises.writeFile(selectionFile, info.names.join('\n'), 'utf8')
      let tail = '', percentage = -1
      const onStdout = text => {
        tail = (tail + text).slice(-4096)
        const matches = [...tail.matchAll(/(?:^|[\s\r\n\b])(\d{1,3})%/g)]
        const next = matches.length ? Math.min(100,Number(matches.at(-1)[1])) : percentage
        if (next > percentage) { percentage=next;onProgress?.({phase:'extract',current:next,total:100,message:`正在解压 ${next}%`}) }
      }
      onProgress?.({phase:'extract',current:0,total:100,message:'正在解压图片'})
      await spawnPromise(_7z, ['x','-y','-spd','-bso0','-bsp1','-scsUTF-8','-i@'+selectionFile,'-o'+directory,'-p123456','--',filepath], 15 * 60 * 1000, { signal, onStdout })
      await fs.promises.unlink(selectionFile)
      // A replaced or edited source must not publish a cache under its old key.
      if (sourceKey(filepath, await fs.promises.stat(filepath)) !== key) throw new Error('解压期间原压缩包发生变化，请重试')
    },
  })
}

const deleteImageFromArchive = async (filename, filepath) => {
  safeEntry(filename)
  const normalize = name => name.replace(/\\/g, '/')
  const originalListing = await archiveListing(filepath)
  const originalImages = validateArchiveListing(originalListing)
  const entry = originalImages.find(name => normalize(name) === normalize(filename))
  if (!entry) throw new Error('压缩包中未找到该图片')
  const expectedImages = originalImages.filter(name => normalize(name) !== normalize(entry)).map(normalize).sort()
  const expectedContents = archiveFileInventory(originalListing).filter(file => file.path !== normalize(entry))
  const { STORE_PATH } = require('../modules/init_folder_setting')
  await editArchiveSafely({
    storePath: STORE_PATH,
    filepath,
    removedEntry: entry,
    modify: staged => spawnPromise(_7z, ['d', '-y', '-spd', '-p123456', '--', staged, entry], 15 * 60 * 1000),
    verify: async staged => {
      await spawnPromise(_7z, ['t', '-bso0', '-bsp0', '-p123456', '--', staged], 15 * 60 * 1000)
      const listing = await archiveListing(staged)
      const remaining = validateArchiveListing(listing).map(normalize).sort()
      if (JSON.stringify(remaining) !== JSON.stringify(expectedImages)) throw new Error('删页后的压缩包内容与预期不一致')
      if (JSON.stringify(archiveFileInventory(listing)) !== JSON.stringify(expectedContents)) throw new Error('删页操作改变了其他文件，已停止替换原包')
    },
  })
  return true
}

function validateArchiveListing(output) {
  let size = 0, count = 0
  const images = []
  for (const fields of archiveFields(output)) {
    if (!fields.Path) continue
    safeEntry(fields.Path)
    if (fields['Symbolic Link'] || fields['Hard Link'] || /(?:^|\s)l[rwx-]{9}/.test(fields.Attributes || '') || /Reparse/.test(fields.Attributes || '')) throw new Error('Archive links are not allowed')
    const entrySize = Number(fields.Size || 0)
    if (!Number.isSafeInteger(entrySize) || entrySize < 0) throw new Error('Invalid archive size')
    size += entrySize
    if (++count > 100000 || size > 16 * 1024 ** 3) throw new Error('Archive exceeds safety limits')
    if (fields.Folder !== '+' && !fields.Path.includes('__MACOSX') && /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(fields.Path)) images.push(fields.Path)
  }
  return images.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}

function archiveFields(output) {
  return output.split(/\r?\n\r?\n/).map(block=>Object.fromEntries(block.split(/\r?\n/).filter(line=>line.includes(' = ')).map(line=>{
    const index=line.indexOf(' = ')
    return [line.slice(0,index),line.slice(index+3)]
  })))
}

function archiveFileInventory(output) {
  const files = []
  for (const block of output.split(/\r?\n\r?\n/)) {
    const fields = Object.fromEntries(block.split(/\r?\n/).filter(line => line.includes(' = ')).map(line => {
      const index = line.indexOf(' = ')
      return [line.slice(0, index), line.slice(index + 3)]
    }))
    if (fields.Path && fields.Folder !== '+' && !/^D/.test(fields.Attributes || '')) {
      files.push({ path: fields.Path.replace(/\\/g, '/'), size: fields.Size || '0', crc: fields.CRC || '' })
    }
  }
  return files.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

async function archiveListing(filepath, options = {}) {
  return spawnPromise(_7z, ['l', '-slt', '-ba', '-sccUTF-8', '-p123456', '--', filepath], 30000, options)
}

async function listArchiveImages(filepath, options = {}) {
  return validateArchiveListing(await archiveListing(filepath, options))
}

module.exports = {
  validateArchiveListing,
  getArchivelist,
  solveBookTypeArchive,
  getImageListFromArchive,
  deleteImageFromArchive
}
