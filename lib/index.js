
var Push = require('./push')

module.exports = SPDY

function SPDY(res) {
  if (!(this instanceof SPDY)) return new SPDY(res)

  this.res = res
}

SPDY.prototype.push = function (a, b, c) {
  return new Push(this.res, a, b, c)
}
