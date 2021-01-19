# connect
Nohost 内部处理请求转发的模块

# 安装
``` sh
npm i --save @nohost/connec
```

# 用法
``` js
const { restoreHeaders, request, tunnel } = require('@nohost/connect');
```

# API

1. `const rawHeaders = restoreHeaders(req|res)`：还原请求或响应头大小写
2. `const svrRes = await request(req, options)` ：
    - options: 可选，目标服务器的 IP（域名）及端口
    - req：请求对下
    - svrRes: 响应对象
3. `tunnel(req, options)`：代理隧道代理及 WebSocket 请求
