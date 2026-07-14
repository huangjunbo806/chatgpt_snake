# 第 6 课：用户认证与 Session

认证用于回答「当前请求属于哪个用户」。本项目使用用户名、密码和服务器端 Session。

## 注册流程

```text
浏览器表单
  → POST /api/auth/register
  → 校验用户名和密码
  → Argon2id 哈希密码
  → 写入 users
  → 创建 Session
  → 浏览器收到 HttpOnly Cookie
```

密码要求为 15–128 个 Unicode 字符。前端只做友好提示，服务器仍会重新校验，不能信任浏览器传来的内容。

## 登录流程

服务器读取用户的密码哈希，再使用 Argon2id 验证密码。用户不存在时也会执行一次虚拟哈希验证，减少通过响应时间猜测用户名是否存在的风险。

登录成功后会重新生成 Session ID，降低 Session Fixation 风险。

## Cookie 与 Session 的区别

- Cookie 保存在浏览器中，本项目只保存随机 Session ID；
- Session 数据保存在 PostgreSQL 中，包含当前用户 ID；
- `HttpOnly` 阻止普通页面 JavaScript 读取 Cookie；
- `SameSite=Lax` 限制部分跨站携带；
- production 环境使用 `Secure`，只通过 HTTPS 发送。

退出登录会销毁服务器 Session，并清除 Cookie。

## 限流

为了减轻暴力尝试：

- 注册按 IP 限制；
- 登录同时按 IP 和标准化用户名限制；
- 登录成功后清理该用户名的失败计数；
- 提交成绩按用户每分钟最多 12 次限制。

当前限流器保存在单个 Node.js 进程内存中。以后部署多个服务器进程时，可以迁移到 Redis 等共享存储。

## 浏览器认证状态

`client/scripts/auth.js` 使用 3 种状态：

- `loading`：正在确认 Session；
- `guest`：游客；
- `authenticated`：已登录用户。

旧请求晚于新登录返回时，generation 会阻止旧结果覆盖新状态。销毁页面控制器时，也会通过 `AbortController` 中止未完成请求。

## 本课练习

1. 注册后刷新页面，观察登录状态仍然存在；
2. 在开发者工具中查看 Cookie，但确认 JavaScript 无法读取 HttpOnly 值；
3. 退出后再次刷新，确认恢复游客状态；
4. 运行 `node --test tests/server/auth-api.test.mjs tests/client/auth.test.mjs`。
