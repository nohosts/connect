const { createServer } = require('http');
const { parse: parseUrl } = require('url');
const { request, tunnel, upgrade, getRawHeaders } = require('../');

const PROXY_OPTIONS = { host: '127.0.0.1', port: 8899 };

const server = createServer(async (req, res) => {
  req.url = 'http://127.0.0.1' + parseUrl(req.url).path;
  req.headers.host = 'local.whistlejs.com';
  try {
    const svrRes = await request(req, PROXY_OPTIONS);
    res.writeHead(svrRes.statusCode, getRawHeaders(svrRes));
    svrRes.pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(e.stack);
  }
});

server.on('upgrade', (req) => {
  upgrade(req, PROXY_OPTIONS);
});

server.on('connect', (req) => {
  tunnel(req, PROXY_OPTIONS);
});

server.listen(9090);
