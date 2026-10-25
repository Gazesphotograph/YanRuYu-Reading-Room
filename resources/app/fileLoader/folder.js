const path = require('path')
const { globIterate, glob } = require('glob')
const { nanoid } = require('nanoid')
const { readdir, stat } = require('fs/promises')
const { shell } = require('electron')
const fs = require('fs')
const { assertWithin, safeEntry } = require('../modules/safety')
const { Op } = require("sequelize")
const { checkCancelled } = require('../modules/archive_cache')

const dirSize = async dir => {
  const files = await readdir(dir, { withFileTypes: true })
  const filesize = files.map(async file => {
    const filepath = path.join(dir, file.name)
    if (file.isFile()) {
      const { size } = await stat(filepath)
      return size
    }
    return 0
  })
  return (await Promise.all(filesize)).flat(Infinity).reduce((i, size) => i + size, 0)
}

const getFolderlist = async (libraryPath, options = {}) => {
  checkCancelled(options.signal)
  const imageList = globIterate('**/*.@(jpg|jpeg|png|webp|avif|gif)', {
    cwd: libraryPath,
    nocase: true,
    nodir: true,
    follow: false,
    absolute: true,
    signal: options.signal
  })
  let list = new Set()
  for await (const image of imageList) {
    checkCancelled(options.signal)
    list.add(path.dirname(image))
  }
  list = [...list]
  return list
}

const solveBookTypeFolder = async (folderpath, TEMP_PATH, COVER_PATH, options = {}) => {
  checkCancelled(options.signal)
  let list = await glob('*.@(jpg|jpeg|png|webp|avif|gif)', {
    cwd: folderpath,
    nocase: true, nodir: true, signal: options.signal
  })
  list = list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })).map(f => path.join(folderpath, f))
  let targetFilePath
  if (list.length > 8) {
    targetFilePath = list[7]
  } else {
    targetFilePath = list[0]
  }
  const tempCoverPath = list[0]
  const coverPath = path.join(COVER_PATH, nanoid() + '.webp')
  const fileStat = await stat(folderpath)
  const bundleSize = await dirSize(folderpath)
  checkCancelled(options.signal)
  return { targetFilePath, tempCoverPath, coverPath, pageCount: list.length, bundleSize, mtime: fileStat?.mtime }
}

const getImageListFromFolder = async (folderpath, VIEWER_PATH, options = {}) => {
  checkCancelled(options.signal)
  let list = await glob('*.@(jpg|jpeg|png|webp|avif|gif)', {
    cwd: folderpath,
    nocase: true, nodir: true, signal: options.signal
  })
  list = list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  checkCancelled(options.signal)
  return list.map(f => ({
    relativePath: f,
    absolutePath: path.join(folderpath, f)
  }))
}

const deleteImageFromFolder = async (filename, folderpath) => {
  safeEntry(filename)
  if (!/\.(jpg|jpeg|png|webp|avif|gif)$/i.test(filename)) throw new Error('Only image files may be removed')
  const filepath = path.join(folderpath, filename)
  await assertWithin(folderpath, filepath)
  if (!(await fs.promises.lstat(filepath)).isFile()) throw new Error('Only image files may be removed')
  try {
    await shell.trashItem(filepath)
  } catch (error) {
    throw new Error(`无法将图片移到回收站，已停止删除并保留原文件：${error.message}`, { cause: error })
  }
  return true
}


const findSameFile = async (filepath, type, Manga) => {
  let fileStat, bundleSize, mtime
  if (type === 'folder') {
    fileStat = await stat(filepath)
    bundleSize = await dirSize(filepath)
    mtime = fileStat.mtime
  } else {
    fileStat = await fs.promises.stat(filepath)
    bundleSize = fileStat.size
    mtime = fileStat.mtime
  }
  const filename = path.basename(filepath)
  const { count, rows } = await Manga.findAndCountAll({
    where: {
      filepath: { [Op.like]: `%${filename}` },
      bundleSize: bundleSize,
      mtime: mtime.toJSON() // mtime is text type in the database
    },
    raw: true
  })
  if (count === 1) {
    return rows[0]
  } else {
    return null
  }
}

module.exports = {
  getFolderlist,
  solveBookTypeFolder,
  getImageListFromFolder,
  deleteImageFromFolder,
  findSameFile
}
