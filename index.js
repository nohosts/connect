const http = require('http');
const net = require('net');
const tls = require('tls');
const { parse: parseUrl } = require('url');
const hparser = require('hparser');

const { getRawHeaders, getRawHeaderNames, formatHeaders } = hparser;
const XFF = 'x-forwarded-for';
const XWCP = 'x-whistle-client-port';
const CLOSED_ERR = new Error('Closed');
const TIMEOUT_ERR = new Error('Timeout');
const TIMEOUT = 5000;
const RETRY_TIMEOUT = 16000;

const isFinished = (req) => {
  if (req.finished) {
    return true;
  }
  const socket = req.socket || req;
  return socket && (socket.destroyed || socket.writable === false);
};

const onClose = (req, callback) => {
  const execCb = (err) => {
    if (!req._hasError) {
      req._hasError = true;
      req._errorObj = err;
      req.destroy();
    }
    if (callback) {
      callback(err);
      callback = null;
    }
  };
  if (req._hasError || isFinished(req)) {
    req._hasError = true;
    return execCb(req._errorObj);
  }
  req.on('error', execCb);
  req.once('close', execCb);
};

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
  const handleError = (err) => {
    clearTimeout(timer);
    if (done) {
      return;
    }
    err = err || TIMEOUT_ERR;
    if (retry) {
      return execCallback(err);
    }
    retry = true;
    handleConnect(); // eslint-disable-line
  };

  const handleConnect = () => {
    timer = setTimeout(handleError, retry ? RETRY_TIMEOUT : TIMEOUT);
    try {
      const module = options.servername ? tls : net;
      socket = module.connect(options, execCallback);
    } catch (e) {
      return execCallback(e);
    }
    onClose(socket, err => handleError(err || CLOSED_ERR));
  };

  handleConnect();

  return () => {
    done = true;
    clearTimeout(timer);
    if (socket) {
      socket.destroy();
    }
  };
};

const getDefaultPort = (options) => {
  return options.servername ? 443 : 80;
};

const parseOptions = (req, options) => {
  if (options && options.host && options.port) {
    return options;
  }
  const { url, headers } = req;
  let host;
  let port;
  if (/^\w+:\/\//.test(url)) {
    const opts = parseUrl(url);
    host = opts.hostname;
    port = opts.port;
  } else if (/^([\w.-]+):([1-9]\d*)$/.test(req.url)) {
    host = RegExp.$1;
    port = RegExp.$2;
  } else if (/^([\w.-]+)(?::([1-9]\d*))?$/.test(headers.host)) {
    host = RegExp.$1;
    port = RegExp.$2;
  }
  options = Object.assign({}, options);
  options.host = options.host || host;
  options.port = options.port || port || getDefaultPort(options);
  return options;
};

const connect = (req, options, res) => {
  if (req._hasError) {
    return Promise.reject(CLOSED_ERR);
  }
  options = parseOptions(req, options);
  return new Promise((resolve, reject) => {
    const _destroy = _connect(options, (err, socket) => {
      if (err) {
        return reject(err);
      }
      resolve(socket);
    });
    onClose(res || req, (err) => {
      _destroy();
      reject(err || CLOSED_ERR);
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
  if (!req.writeHead && !req.isResObject) {
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

const request = async (req, res, options) => {
  req.on('error', () => {
    if (!req._hasError) {
      req._hasError = true;
      res._hasError = true;
      res.destroy();
      res.emit('close');
    }
  });
  const socket = await connect(req, options, res);
  onClose(socket, (e) => {
    if (e) {
      res.destroy();
    } else {
      res.end();
    }
  });
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
    onClose(reqSock, () => socket.destroy());
    // 出错才可以把客户端连接销毁，否则会有问题
    onClose(socket, (e) => {
      if (e) {
        reqSock.destroy();
      } else {
        reqSock.end();
      }
    });
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
exports.tunnel = (req, options) => {
  delete req.headers.upgrade;
  delete req.headers.connection;
  return tunnel(req, options);
};
exports.upgrade = (req, options) => tunnel(req, options, true);
