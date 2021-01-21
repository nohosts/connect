const http = require('http');
const net = require('net');
const { parse: parseUrl } = require('url');
const hparser = require('hparser');

const noop = () => {};
const { getRawHeaders, getRawHeaderNames, formatHeaders } = hparser;
const XFF = 'x-forwarded-for';
const XWCP = 'x-whistle-client-port';
const CLOSED_ERR = new Error('Closed');
const TIMEOUT_ERR = new Error('Timeout');
const TIMEOUT = 5000;
const RETRY_TIMEOUT = 16000;

const _connect = function(options, callback) {
  let socket;
  let timer;
  let done;
  let retry;
  const execCallback = function(err) {
    clearTimeout(timer);
    timer = null;
    if (!done) {
      done = true;
      callback(err, socket);
    }
  };
  const handleError = function(err) {
    clearTimeout(timer);
    if (done) {
      return;
    }
    err = err || (this === socket ? CLOSED_ERR : TIMEOUT_ERR);
    socket.removeAllListeners();
    socket.on('error', noop);
    socket.destroy(err);
    if (retry) {
      return execCallback(err);
    }
    retry = true;
    handleConnect(); // eslint-disable-line
  };

  const handleConnect = () => {
    timer = setTimeout(handleError, retry ? RETRY_TIMEOUT : TIMEOUT);
    try {
      socket = net.connect(options, execCallback);
    } catch (e) {
      return execCallback(e);
    }
    socket.on('error', handleError);
    socket.once('close', handleError);
  };

  handleConnect();

  return (err) => socket && socket.destroy(err);
};

const onClose = (req, cb) => {
  const execCb = (err) => {
    if (req._hasError) {
      req._hasError = true;
      if (typeof req.destroy === 'function') {
        req.destroy();
      }
      if (cb) {
        cb(err || CLOSED_ERR);
      }
    }
  };
  req.on('error', execCb);
  req.once('close', execCb);
};

const parseOptions = (req) => {
  const options = {};
  const { url, headers } = req;
  if (/^\w+:\/\//.test(url)) {
    const opts = parseUrl(url);
    options.host = opts.hostname;
    options.port = opts.port;
  } else if (/^([\w.-]+):([1-9]\d*)$/.test(req.url)) {
    options.host = RegExp.$1;
    options.port = RegExp.$2;
  } else if (/^([\w.-]+)(?::([1-9]\d*))?$/.test(headers.host)) {
    options.host = RegExp.$1;
    options.port = RegExp.$2;
  }
  if (!options.port) {
    options.port = (headers['x-whistle-https-request'] || headers['x-forwarded-proto'] === 'https') ? 443 : 80;
  }
  return options;
};

const connect = (req, options) => {
  if (req._hasError) {
    return Promise.reject(CLOSED_ERR);
  }
  options = options || parseOptions(req);
  return new Promise((resolve, reject) => {
    const _destroy = _connect(options, (err, socket) => {
      if (err) {
        return reject(err);
      }
      resolve(socket);
    });
    onClose(req, (err) => {
      _destroy(err);
      reject(err);
    });
  });
};

const getClientPort = (req) => {
  return req.headers[XWCP] || req.socket.remotePort;
};

const removeIPV6Prefix = (ip) => {
  if (typeof ip !== 'string') {
    return '';
  }
  return ip.indexOf('::ffff:') === 0 ? ip.substring(7) : ip;
};

const getClientIp = (req) => {
  return req.headers[XFF] || removeIPV6Prefix(req.socket.remoteAddress);
};

const restoreHeaders = (req) => {
  const { headers, rawHeaders } = req;
  if (req.writeHead) {
    const ip = getClientIp(req);
    const port = getClientPort(req);
    if (ip) {
      headers[XFF] = ip;
    }
    if (port) {
      headers[XWCP] = port;
    }
  }
  return formatHeaders(headers, rawHeaders && getRawHeaderNames(rawHeaders));
};

const request = async (req, options) => {
  const socket = await connect(req, options);
  return new Promise((resolve, reject) => {
    const client = http.request({
      path: req.url || '/',
      method: req.method,
      createConnection: () => socket,
      agent: null,
      headers: restoreHeaders(req),
    }, resolve).on('error', reject);
    req.pipe(client);
  });
};

const tunnel = async (req, options, isWs) => {
  const reqSock = req.socket;
  try {
    const socket = await connect(req, options);
    socket.write([
      `${isWs ? 'GET' : 'CONNECT'} ${req.url} HTTP/1.1`,
      getRawHeaders(restoreHeaders(req)),
      '\r\n',
    ].join('\r\n'));
    reqSock.pipe(socket).pipe(reqSock);
    onClose(reqSock, (e) => socket.destroy(e));
    onClose(socket, (e) => reqSock.destroy(e));
  } catch (e) {
    const body = e.stack || e.message || '';
    const rawData = [
      'HTTP/1.1 502 Bad Gateway',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '\r\n',
      body,
    ];
    reqSock.end(rawData.join('\r\n'));
  }
};

exports.onClose = onClose;
exports.getRawHeaders = restoreHeaders;
exports.request = request;
exports.tunnel = (req, options) => tunnel(req, options);
exports.upgrade = (req, options) => tunnel(req, options, true);
