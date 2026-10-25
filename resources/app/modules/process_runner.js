const { spawn } = require('child_process')

function spawnPromise(command, args, timeoutMs = 30000, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(Object.assign(new Error('任务已取消'), { name:'AbortError', code:'ABORT_ERR' })); return }
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const output = [], errors = []
    let bytes = 0, failure
    const stop = message => { if (!failure) failure = message instanceof Error ? message : new Error(message); child.kill() }
    const abort = () => stop(Object.assign(new Error('任务已取消'), { name:'AbortError', code:'ABORT_ERR' }))
    options.signal?.addEventListener('abort', abort, { once:true })
    const timeout = setTimeout(() => stop('Archive processing timed out'), timeoutMs)
    const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener('abort',abort) }
    child.on('error', error => { cleanup(); reject(error) })
    child.on('close', code => {
      cleanup()
      if (failure) reject(failure)
      else if (code === 0) resolve(Buffer.concat(output).toString('utf8'))
      else reject(new Error('Archive exit code ' + code + ': ' + Buffer.concat(errors).toString('utf8').slice(0, 2000)))
    })
    for (const [stream, chunks] of [[child.stdout, output], [child.stderr, errors]]) {
      stream.on('data', chunk => {
        if (stream === child.stdout && options.onStdout) {
          try { options.onStdout(chunk.toString('utf8')) } catch (error) { stop(error) }
        }
        bytes += chunk.length
        if (bytes <= 16 * 1024 * 1024) chunks.push(chunk)
        else if (!failure) stop('Archive output exceeds safety limit')
      })
    }
    if (options.signal?.aborted) abort()
  })
}

module.exports = { spawnPromise }
