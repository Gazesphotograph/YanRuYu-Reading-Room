'use strict'

const path = require('node:path')

// Both library views browse the parents of indexed books, including offline sources.
function folderTree(library, filePaths) {
  if (!library) return []
  const root = { label: path.basename(library) || library, value: path.basename(library) || library, folderPath: '' }
  const nodes = new Map([['', root]])
  const directories = new Set(filePaths.filter(file => typeof file === 'string' && path.isAbsolute(file)).map(file => path.dirname(file)))
  for (const directory of [...directories].sort()) {
    const relative = path.relative(library, directory)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue
    let parent = root
    for (const label of relative.split(path.sep)) {
      const folderPath = path.join(parent.folderPath, label)
      if (!nodes.has(folderPath)) {
        const node = { label, value: label, folderPath }
        parent.children ??= []
        parent.children.push(node)
        nodes.set(folderPath, node)
      }
      parent = nodes.get(folderPath)
    }
  }
  return [root]
}

module.exports = { folderTree }
