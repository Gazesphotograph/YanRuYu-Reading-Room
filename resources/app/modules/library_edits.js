'use strict'

// Renderer book objects can outlive an incremental scan. Only a main-process
// cover operation may intentionally replace its generated cover; stale reader
// saves must not restore old page counts or already retired cover files.
const SOURCE_FIELDS = ['id', 'filepath', 'type', 'coverPath', 'hash', 'pageCount', 'bundleSize', 'mtime', 'coverHash',
  'identityFingerprint', 'sourceSignature', 'exist', 'createdAt']

function mergeBookEdits(previous, incoming, approvedCover) {
  const result = { ...previous, ...incoming }
  for (const field of SOURCE_FIELDS) result[field] = previous[field]
  result.date = previous.date ?? incoming.date
  result.readCount = Math.max(Number(previous.readCount) || 0, Number(incoming.readCount) || 0)
  if (approvedCover) {
    result.coverPath = approvedCover.coverPath
    result.coverHash = approvedCover.coverHash
  }
  return result
}

module.exports = { mergeBookEdits }
