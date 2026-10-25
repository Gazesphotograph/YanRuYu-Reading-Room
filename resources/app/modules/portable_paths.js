const fs = require('fs')
const path = require('path')
const { isWithin } = require('./safety')

function resolvePortableSetting(setting, root) {
  const resolved = { ...setting }
  if (setting.library && !fs.existsSync(setting.library)) {
    const parent = path.dirname(root)
    const parents = [parent]
    // Some portable downloads wrap the program in a second folder of the same name.
    if (path.basename(parent).toLowerCase() === path.basename(root).toLowerCase()) parents.push(path.dirname(parent))
    for (const folder of parents) {
      const sibling = path.join(folder, path.basename(path.resolve(setting.library)))
      try {
        if (fs.statSync(sibling).isDirectory()) { resolved.library = sibling; break }
      } catch {}
    }
  }
  const reader = String(setting.imageExplorer || '').replace(/^"|"$/g, '')
  if (path.basename(reader).toLowerCase() === 'manga_reader.exe' && !fs.existsSync(reader)) {
    resolved.imageExplorer = '"' + path.join(root, 'resources/extraResources/manga_reader.exe') + '"'
  }
  return resolved
}

function relocatedBookPath(filepath, originalLibrary, activeLibrary) {
  if (originalLibrary === activeLibrary || !isWithin(originalLibrary, filepath, true)) return filepath
  return path.join(activeLibrary, path.relative(originalLibrary, filepath))
}

module.exports = { resolvePortableSetting, relocatedBookPath }
