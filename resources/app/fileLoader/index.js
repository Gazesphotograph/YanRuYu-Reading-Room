const fs = require('fs')
const path = require('node:path')
const { nanoid } = require('nanoid')
const { Worker } = require('worker_threads')
const { hashFile, assertWithin } = require('../modules/safety')
const { getArchiveCache, checkCancelled, abortError } = require('../modules/archive_cache')
const sharp = require('sharp')
const { getFolderlist, solveBookTypeFolder, getImageListFromFolder, deleteImageFromFolder } = require('./folder.js')
const { getArchivelist, solveBookTypeArchive, getImageListFromArchive, deleteImageFromArchive } = require('./archive.js')
const { getZipFilelist } = require('./zip.js')
const solveBookTypeZip = (filepath, tempRoot, coverRoot, options = {}) => new Promise((resolve, reject) => {
  checkCancelled(options.signal)
  const worker = new Worker(path.join(__dirname, 'zip-worker.js'), { workerData: [filepath,tempRoot,coverRoot], resourceLimits: { maxOldGenerationSizeMb: 256 } })
  let stopped
  // The scan owns its temporary folder. Do not report cancellation until the
  // fallback worker has stopped writing, or its caller could clear it early.
  const stop = error => { stopped ||= error;worker.terminate().then(()=>reject(stopped),reject) }
  const abort = () => stop(abortError())
  options.signal?.addEventListener('abort',abort,{once:true})
  const timer = setTimeout(() => stop(new Error('ZIP fallback timed out')), 120000)
  const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort)}
  worker.once('message', result => { if(stopped)return;cleanup();result.error ? reject(new Error(result.error)) : resolve(result.value) })
  worker.once('error', error => { cleanup(); reject(error) })
  worker.once('exit', code => { cleanup();if(stopped)reject(stopped);else if(code)reject(new Error('ZIP worker exited: ' + code)) })
  if(options.signal?.aborted)abort()
})
const { TEMP_PATH, COVER_PATH, VIEWER_PATH } = require('../modules/init_folder_setting.js')

const getBookFilelist = async (library, options = {}) => {
  checkCancelled(options.signal)
  const folderList = await getFolderlist(library, options)
  const archiveList = await getArchivelist(library, options)
  const zipList = await getZipFilelist(library, options)
  return [
    ...folderList.map(filepath => ({ filepath, type: 'folder' })),
    ...archiveList.map(filepath => ({ filepath, type: 'archive' })),
    ...zipList.map(filepath => ({ filepath, type: 'zip' })),
  ]
}

const geneCover = async (filepath, type, options = {}) => {
  checkCancelled(options.signal)
  const tempRoot = options.tempRoot || TEMP_PATH
  await fs.promises.mkdir(tempRoot,{recursive:true})
  let targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime
  switch (type) {
    case 'folder':
      ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeFolder(filepath, tempRoot, COVER_PATH, options))
      break
    case 'zip':
      try {
        ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeArchive(filepath, tempRoot, COVER_PATH, options))
      } catch (e) {
        checkCancelled(options.signal)
        console.log(e)
        console.log(`reload ${filepath} use adm-zip`)
        ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeZip(filepath, tempRoot, COVER_PATH, options))
      }
      break
    case 'archive':
      ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeArchive(filepath, tempRoot, COVER_PATH, options))
      break
    default:
      throw new Error(`unsupported book type: ${type}`)
  }

  // 缺这两个检查时,空目录会以 ERR_INVALID_ARG_TYPE 报错,看不出是哪本书出问题
  if (!tempCoverPath || !fs.existsSync(tempCoverPath)) {
    throw new Error(`no cover image found for ${filepath}`)
  }
  checkCancelled(options.signal)
  const coverHash = await hashFile(tempCoverPath)
  const copyTempCoverPath = path.join(tempRoot, nanoid(8) + path.extname(tempCoverPath))
  await fs.promises.copyFile(tempCoverPath, copyTempCoverPath)
  try {
    await sharp(copyTempCoverPath, { failOnError: false })
    .rotate()
    .resize(1000, 1000, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .toFile(coverPath)
    checkCancelled(options.signal)
  } catch (error) {
    if(coverPath&&fs.existsSync(coverPath)){await assertWithin(COVER_PATH,coverPath);await fs.promises.unlink(coverPath)}
    throw error
  }
  return { targetFilePath, coverPath, pageCount, bundleSize, mtime, coverHash }
}

const getImageListByBook = async (filepath, type, options = {}) => {
  checkCancelled(options.signal)
  switch (type) {
    case 'folder':
      return await getImageListFromFolder(filepath, VIEWER_PATH, options)
    case 'zip':
    case 'archive':
      return await getImageListFromArchive(filepath, VIEWER_PATH, options)
    default:
      return await getImageListFromArchive(filepath, VIEWER_PATH, options)
  }
}

const getImageCacheStatus = () => getArchiveCache(VIEWER_PATH).getStatus()
const setImageCacheBudget = bytes => getArchiveCache(VIEWER_PATH).setBudget(bytes)
const clearUnusedImageCache = () => getArchiveCache(VIEWER_PATH).clearUnused()
const releaseImageCache = owner => getArchiveCache(VIEWER_PATH).release(owner)

const deleteImageFromBook = async (filename, filepath, type) => {
  if(type!=='folder')await getArchiveCache(VIEWER_PATH).invalidateSource(filepath)
  switch (type) {
    case 'folder':
      return await deleteImageFromFolder(filename, filepath)
    case 'zip':
    case 'archive':
      return await deleteImageFromArchive(filename, filepath)
    default:
      return await deleteImageFromArchive(filename, filepath)
  }
}

module.exports = {
  getBookFilelist,
  geneCover,
  getImageListByBook,
  deleteImageFromBook,
  getImageCacheStatus,
  setImageCacheBudget,
  clearUnusedImageCache,
  releaseImageCache
}
