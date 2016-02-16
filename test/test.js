
var spdy = require('spdy')
var https = require('https')
var zlib = require('mz/zlib')
var assert = require('assert')
var keys = require('spdy-keys')
var join = require('path').join
var Readable = require('stream').Readable
var Promise = require('any-promise')

var SPDY = require('..')

var port
var server
var agent

afterEach(function (done) {
  agent.close()
  server.close(done)
})

describe('Streams', function () {
  describe('when empty', function () {
    it('should push', function () {
      return listen(function (req, res) {
        var stream = new Readable()
        stream._read = noop
        stream.push(null)

        return SPDY(res).push('/', {
          body: stream
        })
      }).then(pull).then(function (res) {
        res.resume()
        return new Promise(function (resolve, reject) {
          res.on('end', resolve)
          res.on('error', reject)
        })
      })
    })
  })

  describe('when text', function () {
    it('should gzip', function () {
      return listen(function (req, res) {
        var stream = new Readable()
        stream._read = noop
        stream.push('klajsdlfjalsdkfjalsdjkfsjdf')
        stream.push(null)

        return SPDY(res).push('/', {
          headers: {
            'content-type': 'text/plain'
          },
          body: stream
        })
      }).then(pull).then(function (res) {
        res.resume()
        assert.equal(res.headers['content-encoding'], 'gzip')
        assert(~res.headers['content-type'].indexOf('text/plain'))
        assert.equal(res.url, '/')
      })
    })
  })

  describe('when image', function () {
    it('should not gzip', function () {
      return listen(function (req, res) {
        var stream = new Readable()
        stream._read = noop
        stream.push(null)

        return SPDY(res).push('/', {
          headers: {
            'content-type': 'image/png'
          },
          body: stream
        })
      }).then(pull).then(function (res) {
        res.resume()
        assert(res.headers['content-encoding'] == null)
        assert.equal(res.headers['content-type'], 'image/png')
      })
    })
  })

  describe('when svg', function () {
    it('should push', function () {
      return listen(function (req, res) {
        return SPDY(res).push('/fontawesome-webfont.svg', {
          filename: join(__dirname, 'fontawesome-webfont.svg')
        })
      }).then(pull).then(function (res) {
        res.resume()
        assert.equal(res.headers['content-encoding'], 'gzip')
        assert(~res.headers['content-type'].indexOf('image/svg+xml'))
      })
    })
  })
})

describe('Strings', function () {
  describe('when no content-type is set', function () {
    it('should set the content-type if possible', function () {
      return listen(function (req, res) {
        return SPDY(res).push('/some.txt', {
          body: 'lol'
        })
      }).then(pull).then(function (res) {
        assert(~res.headers['content-type'].indexOf('text/plain'))
      })
    })
  })

  describe('when content-encoding is already set', function () {
    it('should not compress', function () {
      return listen(function (req, res) {
        return SPDY(res).push('/something.txt', {
          body: 'klajsldkfjaklsdjflkajdsflkajsdlkfjaklsdjf',
          threshold: 1,
          headers: {
            'content-encoding': 'identity'
          }
        })
      }).then(pull).then(function (res) {
        assert.equal(res.headers['content-encoding'], 'identity')
        assert(~res.headers['content-type'].indexOf('text/plain'))
      })
    })
  })

  describe('when empty', function () {
    it('should push', function () {
      return listen(function (req, res) {
        return SPDY(res).push('/some.txt', {
          body: ''
        })
      }).then(pull).then(function (res) {
        assert(~res.headers['content-type'].indexOf('text/plain'))
      })
    })
  })
})

describe('Buffers', function () {
  describe('when already compressed', function () {
    it('should not compress', function () {
      return zlib.gzip('lol').then(function (body) {
        listen(function (req, res) {
          return SPDY(res).push({
            path: '/',
            threshold: 1,
            headers: {
              'content-encoding': 'gzip',
              'content-type': 'text/plain'
            },
            body: body
          })
        })
      }).then(pull).then(function (res) {
        res.resume()
        assert.equal(res.headers['content-encoding'], 'gzip')
        assert(~res.headers['content-type'].indexOf('text/plain'))
      })
    })
  })

  describe('when compressing', function () {
    it('should remove the content-length', function () {
      return listen(function (req, res) {
        return SPDY(res).push({
          path: '/something.txt',
          body: new Buffer(2048),
          headers: {
            'content-length': '2048'
          }
        })
      }).then(pull).then(function (res) {
        assert.equal(res.headers['content-encoding'], 'gzip')
        assert(~res.headers['content-type'].indexOf('text/plain'))
        assert(res.headers['content-length'] == null)
      })
    })
  })
})

describe('Compression', function () {
  describe('Thresholds', function () {
    it('should not compress when below the threshold', function () {
      return listen(function (req, res) {
        return SPDY(res).push({
          path: '/something.txt',
          body: 'lol'
        })
      }).then(pull).then(function (res) {
        assert(!res.headers['content-encoding'])
      })
    })

    it('should compress when above the threshold', function () {
      return listen(function (req, res) {
        return SPDY(res).push({
          path: '/something.txt',
          body: 'lol',
          threshold: 1
        })
      }).then(pull).then(function (res) {
        assert.equal(res.headers['content-encoding'], 'gzip')
      })
    })
  })

  describe('.compress', function () {
    it('should not compress when false', function () {
      return listen(function (req, res) {
        return SPDY(res).push({
          path: '/something.txt',
          body: 'lol',
          threshold: 1,
          compress: false
        })
      }).then(pull).then(function (res) {
        assert(!res.headers['content-encoding'])
      })
    })
  })
})

describe('Disconnections', function () {
  it('should not leak file descriptors', function (done) {
    var stream = new Readable()
    stream._read = noop
    stream.destroy = done

    return listen(function (req, res) {
      return SPDY(res).push('/', {
        body: stream
      })
    }).then(pull).then(function (res) {
      res.destroy()
    }).catch(done)
  })
})

function listen (fn) {
  return new Promise(function (resolve, reject) {
    server = spdy.createServer({
      key: keys.key,
      cert: keys.cert,
      ca: keys.ca,

      spdy: {
        protocols: ['h2']
      }
    }, function (req, res) {
      var defer
      try {
        defer = fn(req, res)
      } catch (err) {
        console.error(err.stack)
        res.statusCode = 500
        res.end()
        return
      }

      defer.then(function () {
        res.statusCode = 204
        res.end()
      }).catch(function (err) {
        console.error(err.stack)
        res.statusCode = 500
        res.end()
      })
    }).listen(port, function (err) {
      if (err) return reject(err)
      port = this.address().port
      resolve()
    })
  })
}

function pull () {
  return new Promise(function (resolve, reject) {
    agent = spdy.createAgent({
      port: port,
      rejectUnauthorized: false,
      spdy: {
        protocols: ['h2']
      }
    })

    https.get({
      agent: agent,
      path: '/'
    })
    .once('error', reject)
    .once('response', function (res) {
      if (res.statusCode !== 204) reject(new Error('got status code: ' + res.statusCode))
      res.resume()
    })
    .on('push', resolve)
  })
}

function noop () {}
