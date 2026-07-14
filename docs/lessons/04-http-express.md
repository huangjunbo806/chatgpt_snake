# 第 4 课：理解 HTTP 与 Express

浏览器与服务器通过 HTTP 通信。浏览器发送请求，Express 根据方法和路径执行对应代码，再返回状态码和 JSON。

## 请求和响应

获取排行榜的请求可以理解为：

```text
GET /api/leaderboard
```

成功响应为：

```json
{
  "data": {
    "entries": [],
    "me": null
  }
}
```

错误使用统一结构：

```json
{
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "请先登录",
    "requestId": "服务器生成的请求编号"
  }
}
```

## Express 的职责

`server/app.js` 按顺序安装中间件（Middleware）：

1. 生成请求编号；
2. 添加安全响应头；
3. 处理健康检查；
4. 保护 `/api` 写请求；
5. 解析 JSON；
6. 读取 Session；
7. 执行认证、成绩和排行榜路由；
8. 提供静态网页；
9. 统一处理 404 和异常。

中间件顺序很重要。例如 Session 必须在需要登录信息的路由之前执行。

## 路由、Service 和 Repository

服务端分为 3 个主要层次：

- Route：读取 HTTP 请求并返回 HTTP 响应；
- Service：执行注册、登录、成绩等业务规则；
- Repository：执行参数化 SQL，与 PostgreSQL 交互。

这种拆分让 HTTP、业务规则和数据库细节可以分别测试。

## 同源写请求保护

注册、登录、退出和提交成绩都会修改服务器状态。浏览器客户端需要发送：

```http
Content-Type: application/json
X-Docker-Snake-Request: 1
Origin: http://localhost:3000
```

`Origin` 由浏览器自动添加，前端代码不会手工伪造。服务器会把它与 `PUBLIC_ORIGIN` 比较。

## 健康检查

启动服务后访问：

```bash
curl http://localhost:3000/healthz
```

数据库可用时返回 HTTP 200。数据库不可用时返回 HTTP 503，但不会把数据库密码或内部错误直接发给浏览器。

## 本课练习

1. 打开浏览器开发者工具的 Network 面板；
2. 刷新排行榜，观察 `GET /api/leaderboard`；
3. 注册一次，观察请求方法、JSON 和响应状态码；
4. 运行 `node --test tests/server/app.test.mjs tests/server/scores-api.test.mjs`。
