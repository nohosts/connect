# connect
Nohost 内部处理请求转发的模块

# 安装
``` sh
npm i --save @nohost/connect
```

# 用法
``` js
const { getRawHeaders, request, tunnel, upgrade } = require('@nohost/connect');
```

# API

1. `const rawHeaders = getRawHeaders(req|res)`：还原请求或响应头大小写
2. `const svrRes = await request(req, res, options)` ：
    - options: 可选，目标服务器的 IP（域名）及端口
    - req：请求对象
    - res: 响应对象
    - svrRes: 上游服务响应对象
3. `tunnel(req, options)`：代理隧道代理
4. `upgrade(req, options)`：转发 WebSocket 请求

# 例子
参考：https://github.com/nohosts/router/blob/master/lib/connect.js
