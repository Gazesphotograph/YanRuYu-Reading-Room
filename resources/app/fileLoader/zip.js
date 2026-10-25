const fs = require('fs')
const path = require('path')
const { glob } = require('glob')
const AdmZip = require('adm-zip')
const { nanoid } = require('nanoid')
const _ = require('lodash')
const { safeEntry } = require('../modules/safety')
const { checkCancelled } = require('../modules/archive_cache')

const getZipFilelist = async (libraryPath, options = {}) => {
  checkCancelled(options.signal)
  const list = await glob('**/*.@(zip|cbz)', {
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

const solveBookTypeZip = async (filepath, TEMP_PATH, COVER_PATH) => {
  const tempFolder = path.join(TEMP_PATH, nanoid(8))
  const zip = new AdmZip(filepath)
  const zipFileList = zip.getEntries()
  let expandedSize = 0
  for (const entry of zipFileList) {
    safeEntry(entry.entryName)
    expandedSize += entry.header.size
    if ((entry.header.attr >>> 16 & 0xf000) === 0xa000 || expandedSize > 16 * 1024 ** 3) throw new Error('Unsafe ZIP archive')
  }
  if (zipFileList.length > 100000) throw new Error('Too many ZIP entries')
  const findZFile = (entryName) => {
    return _.find(zipFileList, zFile => zFile.entryName == entryName)
  }
  const fileList = zipFileList.map(zFile => zFile.entryName)
  let imageList = _.filter(fileList, filepath => _.includes(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'], path.extname(filepath).toLowerCase()))
  imageList = imageList.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))

  let targetFile
  let targetFilePath
  let coverFile
  let tempCoverPath
  let coverPath
  if (imageList.length > 8) {
    targetFile = imageList[7]
    coverFile = imageList[0]
    zip.extractEntryTo(findZFile(targetFile), tempFolder, true, true)
    zip.extractEntryTo(findZFile(coverFile), tempFolder, true, true)
  } else if (imageList.length > 0) {
    targetFile = imageList[0]
    coverFile = imageList[0]
    zip.extractEntryTo(findZFile(targetFile), tempFolder, true, true)
  } else {
    throw new Error('compression package isnot include image')
  }

  targetFilePath = path.join(TEMP_PATH, nanoid(8) + path.extname(targetFile))
  await fs.promises.copyFile(path.join(tempFolder, targetFile), targetFilePath)

  tempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(imageList[0]))
  await fs.promises.copyFile(path.join(tempFolder, imageList[0]), tempCoverPath)

  coverPath = path.join(COVER_PATH, nanoid() + '.webp')

  const fileStat = await fs.promises.stat(filepath)
  return {targetFilePath, tempCoverPath, coverPath, pageCount: imageList.length, bundleSize: fileStat?.size, mtime: fileStat?.mtime}
}

module.exports = {
  getZipFilelist,
  solveBookTypeZip
}
