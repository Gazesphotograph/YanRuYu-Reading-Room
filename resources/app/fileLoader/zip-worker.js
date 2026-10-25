const { parentPort, workerData } = require('worker_threads')
require('./zip').solveBookTypeZip(...workerData).then(value => parentPort.postMessage({ value })).catch(error => parentPort.postMessage({ error: error.message }))
