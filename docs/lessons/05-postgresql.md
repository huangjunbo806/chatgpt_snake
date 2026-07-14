# 第 5 课：用 PostgreSQL 持久化数据

浏览器关闭后，服务器仍需要保存账户和最高分，因此数据不能只放在 JavaScript 变量中。本项目使用 PostgreSQL。

## 数据表

初始迁移 `db/migrations/001-initial-schema.sql` 创建：

- `users`：用户名、密码哈希、最高分和时间；
- `user_sessions`：登录 Session；
- `schema_migrations`：由迁移程序维护已执行版本。

`users` 不保存明文密码，只保存 Argon2id 生成的 `password_hash`。

## 约束的作用

数据库不仅存数据，也保护数据：

- 用户名必须唯一；
- 用户名只能使用小写字母、数字和下划线；
- 最高分在 0–3960 之间，并且是 10 的倍数；
- 0 分没有最高分时间，正分必须有时间。

即使应用代码出现错误，数据库约束也会拒绝明显非法的数据。

## 数据库迁移

迁移是按顺序执行的 SQL 文件。服务启动时会：

1. 读取 `db/migrations/`；
2. 获取 PostgreSQL advisory lock，避免多个进程同时迁移；
3. 校验已执行迁移的 SHA-256；
4. 在事务中执行新迁移；
5. 记录版本和校验值。

已经应用的迁移不要直接修改。需要改变表结构时，应新增下一编号文件，例如 `002-add-profile.sql`。

## Pool 和 Repository

`server/database/pool.js` 创建连接池（Pool），复用数据库连接。Repository 使用 `$1`、`$2` 等参数占位符：

```sql
SELECT id, username
FROM public.users
WHERE id = $1
```

不要把用户名直接拼进 SQL 字符串，否则可能产生 SQL 注入。

## 独立测试数据库

真实集成测试会清理项目表，因此只能连接名字以 `_test` 或 `-test` 结尾的独立数据库。测试助手还会核对实际数据库名和数据库用户。

```bash
TEST_DATABASE_URL=postgresql://docker_snake:密码@localhost:5432/docker_snake_test \
  npm run test:integration
```

没有设置安全测试 URL 时，集成测试显示 `SKIP` 是正常现象。

## 本课练习

1. 用 `psql` 连接开发数据库；
2. 执行 `\d public.users` 查看表结构；
3. 注册一个账户后执行 `SELECT id, username, best_score FROM public.users;`；
4. 确认表中没有明文密码。
