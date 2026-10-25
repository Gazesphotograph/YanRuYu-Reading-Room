const { app } = require('electron')
const { programRoot } = require('./data_paths')

const getRootPath = () => programRoot(app)

module.exports = {
  getRootPath
}
