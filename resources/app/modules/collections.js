'use strict'

const { randomUUID } = require('crypto')
const { validBookId } = require('./reading_state')
const copy = value => JSON.parse(JSON.stringify(value))

function validateCollections(value) {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('合集档案格式无效')
  const ids = new Set()
  for (const collection of value) {
    if (!collection || typeof collection !== 'object' || Array.isArray(collection) || !validBookId(collection.id) || ids.has(collection.id) ||
        typeof collection.title !== 'string' || !Array.isArray(collection.list) || collection.list.length > 100000 || collection.list.some(id => !validBookId(id))) throw new Error('合集内容无效')
    ids.add(collection.id)
  }
  return copy(value)
}

function resolveMembers(collection, books) {
  const byId = new Map(books.map(book => [book.id, book])), byHash = new Map(), ids = new Set(), unresolved = new Set()
  for (const book of books) if (book.hash) {
    const matches = byHash.get(book.hash) || []
    matches.push(book.id); byHash.set(book.hash, matches)
  }
  for (const reference of collection.list) {
    if (byId.has(reference)) ids.add(reference)
    else if (byHash.has(reference)) for (const id of byHash.get(reference)) ids.add(id)
    else unresolved.add(reference)
  }
  return { bookIds: [...ids], unresolved: [...unresolved] }
}

function createCollectionService({ getCollections, getBooks, saveCollections } = {}) {
  return {
    async command(params = {}) {
      const collections = validateCollections(await getCollections()), books = await getBooks()
      const describe = (value, extra = {}) => ({ collections: value, memberships: Object.fromEntries(value.map(collection => [collection.id, resolveMembers(collection, books)])), ...extra })
      const title = value => {
        if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('合集名称需要 1 至 200 个字符')
        return value.trim()
      }
      const bookIds = value => {
        if (!Array.isArray(value) || value.length > 2000 || value.some(id => !validBookId(id))) throw new Error('一次最多选择 2000 本书加入或移出合集')
        const unique = [...new Set(value)], known = new Set(books.map(book => book.id))
        if (unique.some(id => !known.has(id))) throw new Error('所选书籍已不在书库，请重新选择')
        return unique
      }
      if (params.action === 'list') return describe(collections)
      let collectionId = params.collectionId
      if (params.action === 'create') {
        collectionId = randomUUID()
        collections.push({ id: collectionId, title: title(params.title), list: bookIds(params.bookIds || []) })
      } else {
        const collection = collections.find(item => item.id === collectionId)
        if (!collection) throw new Error('合集已不存在，请重新选择')
        if (params.action === 'rename') collection.title = title(params.title)
        else if (params.action === 'remove') collections.splice(collections.indexOf(collection), 1)
        else if (params.action === 'members') {
          const add = bookIds(params.addBookIds || []), remove = new Set(bookIds(params.removeBookIds || []))
          if (add.some(id => remove.has(id))) throw new Error('同一本书不能同时加入和移出合集')
          // Resolve old sampled hashes before applying a single-book removal.
          // Copies that share that hash retain their separate, stable IDs.
          const members = resolveMembers(collection, books)
          collection.list = [...new Set([...members.bookIds.filter(id => !remove.has(id)), ...add, ...members.unresolved])]
        } else throw new Error('不支持的合集操作')
      }
      const next = validateCollections(collections)
      await saveCollections(next)
      return describe(next, { collectionId, changed: true })
    }
  }
}

module.exports = { validateCollections, resolveMembers, createCollectionService }
