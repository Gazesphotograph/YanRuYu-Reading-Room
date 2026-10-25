const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { getRootPath } = require('./utils.js')
const { resolveDataPaths } = require('./data_paths.js')


const { storePath: STORE_PATH, profilePath: PROFILE_PATH, mode: DATA_MODE, isPortable } = resolveDataPaths(app)
fs.mkdirSync(STORE_PATH, { recursive: true })
fs.mkdirSync(PROFILE_PATH, { recursive: true })

// Import cleanup owns this directory only. Historical root/tmp may contain
// project files or user work and must never be emptied by a library scan.
const TEMP_PATH = path.join(STORE_PATH, '.cache', 'import-temp')
const COVER_PATH = path.join(STORE_PATH, 'cover')
const VIEWER_PATH = path.join(STORE_PATH, 'viewer')

const preparePath = () => {
  fs.mkdirSync(PROFILE_PATH, { recursive: true })
  fs.mkdirSync(TEMP_PATH, { recursive: true })
  fs.mkdirSync(COVER_PATH, { recursive: true })
  fs.mkdirSync(VIEWER_PATH, { recursive: true })
}

const _mange_reader = `"${path.join(getRootPath(), 'resources/extraResources/manga_reader.exe')}"`

const SETTING_PATH = path.join(STORE_PATH, 'setting.json')
const COLLECTION_PATH = path.join(STORE_PATH, 'collectionList.json')

const writeJsonAtomic = (target, data) => {
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, '  '), { encoding: 'utf-8' })
  fs.renameSync(tmp, target)
}

const prepareSetting = () => {
  const DEFAULT_SETTING = {
    proxy: undefined,
    library: app.getPath('downloads'),
    metadataPath: undefined,
    imageExplorer: _mange_reader,
    pageSize: 42,
    loadOnStart: false,
    igneous: '',
    ipb_pass_hash: '',
    ipb_member_id: '',
    star: '',
    showComment: true,
    requireGap: 3000,
    thumbnailColumn: 10,
    showTranslation: false,
    theme: 'light e-hentai',
    widthLimit: undefined,
    directEnter: 'detail',
    language: 'default',
    folderTreeWidth: '',
    advancedSearch: true,
    autoCheckUpdates: false,
    customOptions: '',
    defaultExpandTree: true,
    hidePageNumber: false,
    skipDeleteConfirm: false,
    displayTitle: 'japaneseTitle',
    keepReadingProgress: true,
  }

  let raw
  try {
    raw = fs.readFileSync(SETTING_PATH, { encoding: 'utf-8' })
  } catch (e) {
    if (e.code === 'ENOENT') {
      const setting = { ...DEFAULT_SETTING }
      writeJsonAtomic(SETTING_PATH, setting)
      return setting
    }
    // 文件存在但读不了(被占用/权限),用默认值跑但绝不覆盖原文件
    console.error('Cannot read setting.json, using defaults WITHOUT overwriting it:', e)
    return { ...DEFAULT_SETTING }
  }
  try {
    // 去掉 BOM,否则 JSON.parse 失败会导致整份设置被默认值覆盖
    const setting = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (setting.imageExplorer === '"C:\\Windows\\explorer.exe"') {
      setting.imageExplorer = _mange_reader
      writeJsonAtomic(SETTING_PATH, setting)
    }
    return setting
  } catch (e) {
    const backup = `${SETTING_PATH}.corrupt-${Date.now()}.bak`
    try { fs.copyFileSync(SETTING_PATH, backup) } catch {}
    console.error(`setting.json is not valid JSON, backed up to ${backup}; using defaults in memory only:`, e)
    return { ...DEFAULT_SETTING }
  }
}

const prepareCollectionList = () => {
  let raw
  try {
    raw = fs.readFileSync(COLLECTION_PATH, { encoding: 'utf-8' })
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('Cannot read collectionList.json:', e)
      return []
    }
    writeJsonAtomic(COLLECTION_PATH, [])
    return []
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    const backup = `${COLLECTION_PATH}.corrupt-${Date.now()}.bak`
    try { fs.copyFileSync(COLLECTION_PATH, backup) } catch {}
    console.error(`collectionList.json is not valid JSON, backed up to ${backup}:`, e)
    return []
  }
}

module.exports = {
  STORE_PATH,
  PROFILE_PATH,
  DATA_MODE,
  isPortable,
  TEMP_PATH,
  COVER_PATH,
  VIEWER_PATH,
  prepareSetting,
  prepareCollectionList,
  preparePath,
  _mange_reader,
}
