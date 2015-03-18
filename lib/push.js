
var Promise = require('native-or-bluebird')
var compressible = require('compressible')
var debug = require('debug')('spdy-push')
var basename = require('path').basename
var resolve = require('path').resolve
var mime = require('mime-types')
var dethroy = require('destroy')
var assert = require('assert')
var zlib = require('mz/zlib')
var bytes = require('bytes')
var fs = require('fs')

module.exports = Push

function Push(res, path, options, priority) {
  for (var i = 1; i < arguments.length; i++) {
    var arg = arguments[i];
    switch (typeof arg) {
      case 'number':
        priority = arg
        break
      case 'string':
        path = arg
        break
      case 'object':
        options = arg
        if ('priority' in options) priority = options.priority
        if ('path' in options) path = options.path
        break
    }
  }

  this.res = res
  this.options = options = options || {}
  var headers = this.headers = options.headers || {}

  this.path = path
  assert(this.path, 'path must be defined')
  this.priority = priority == null
    ? 7
    : priority
  assert(this.priority >= 0 && this.priority <= 7, 'Priority must be between 0-7')

  if (typeof options.filter === 'function') {
    this.filter = options.filter
  }
  if (typeof options.threshold === 'string') {
    this.threshold = bytes(options.threshold)
  } else if (typeof options.threshold === 'number') {
    this.threshold = options.threshold
  }

  // set the body and content-length if possible
  if (Buffer.isBuffer(options.body)) {
    this.body = options.body
    this.bodyType = 'buffer'
    this.length = headers['content-length'] = options.body.length
  } else if (typeof options.body === 'string') {
    this.body = options.body
    this.bodyType = 'string'
    this.length = headers['content-length'] = Buffer.byteLength(options.body)
  } else if (options.body && typeof options.body.pipe === 'function') {
    this.body = options.body
    this.bodyType = 'stream'
    if (headers['content-length']) this.length = parseInt(headers['content-length'], 10)
  } else if (typeof options.filename === 'string') {
    this.filename = resolve(options.filename)
    if (headers['content-length']) this.length = parseInt(headers['content-length'], 10)
  } else {
    throw new Error('You must either set .body or .filename')
  }

  // set the content type
  this.type = headers['content-type']
  if (!this.type) {
    var type = mime.contentType(basename(path))
    if (type) this.type = headers['content-type'] = type
  }

  this._handleCompression()

  this._acknowledgeDeferred = this._acknowledge().catch(filterError)
  this._sendDeferred = this._send().catch(filterError)
}

// compression options
Push.prototype.filter = compressible
Push.prototype.threshold = 1024

// other default options
Push.prototype.priority = 7 // lowest priority be default

/**
 * Make `push()` into a promise.
 */

Push.prototype.then = function (resolve, reject) {
  return this._acknowledgeDeferred.then(resolve, reject)
}

Push.prototype.catch = function (reject) {
  return this._acknowledgeDeferred.catch(reject)
}

Push.prototype.acknowledge = function () {
  return this._acknowledgeDeferred
}

Push.prototype.send = function () {
  return this._sendDeferred
}

Push.prototype._acknowledge = function () {
  var self = this
  var stream =
  this.stream = this.res.push(this.path, this.headers, this.priority)
  return new Promise(function (resolve, reject) {
    stream.on('acknowledge', acknowledge)
    stream.on('error', cleanup)
    stream.on('close', cleanup)

    function acknowledge() {
      cleanup()
      resolve()
    }

    function cleanup(err) {
      stream.removeListener('acknowledge', acknowledge)
      stream.removeListener('error', cleanup)
      stream.removeListener('close', cleanup)
      if (err) {
        if (self.bodyType === 'stream') dethroy(self.body)
        reject(err)
      }
    }
  })
}

Push.prototype._send = function () {
  var self = this
  return this._acknowledgeDeferred.then(function () {
    var stream = self.stream
    // empty body and no filename
    if (!self.body && !self.filename) return stream.end()

    // send the string or buffer
    if (self.bodyType === 'string' || self.bodyType === 'buffer') {
      if (!self.compress) return stream.end(self.body)
      return zlib.gzip(self.body).then(function (body) {
        stream.end(body)
      }, function (err) {
        dethroy(stream)
        throw err
      })
    }

    return new Promise(function (resolve, reject) {
      // send a stream
      var body = self.filename ? fs.createReadStream(self.filename) : self.body
      body.on('error', destroy)
      if (self.compress) {
        body.pipe(zlib.Gzip(self.compress))
          .on('error', destroy)
          .pipe(stream)
      } else {
        body.pipe(stream)
      }

      stream.on('error', destroy)
      stream.on('close', destroy)
      stream.on('finish', destroy)

      function destroy(err) {
        dethroy(body)

        stream.removeListener('error', destroy)
        stream.removeListener('close', destroy)
        stream.removeListener('finish', destroy)

        if (err) reject(err)
        else resolve()

        stream.on('error', postDestroyError)
      }
    })
  })
}

Push.prototype._handleCompression = function () {
  var options = this.options
  // manually disabled compression
  if (options.compress === false) return this.compress = false
  var headers = this.headers
  // already compressed or something
  if (headers['content-encoding']) return this.compress = false
  // below threshold
  if (typeof this.length === 'number' && this.length < this.threshold) return this.compress = false
  this.compress = this.filter(this.type)
  if (!this.compress) return
  this.compress = typeof options.compress === 'object'
    ? options.compress
    : {}
  headers['content-encoding'] = 'gzip'
  delete headers['content-length']
}

// we don't care about these errors
// and we don't want to clog up `this.onerror`
function filterError(err) {
  if (!err || !(err instanceof Error)) return
  if (err.code === 'RST_STREAM') {
    debug('got RST_STREAM %s', err.status)
    return
  }
  // WHY AM I GETTING THESE ERRORS?
  if (err.message === 'Write after end!') return
  throw err
}

// sometimes this happens and crashes the entire server
function postDestroyError(err) {
  console.error(err.stack)
}
