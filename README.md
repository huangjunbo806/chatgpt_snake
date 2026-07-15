# Docker Snake 全栈学习版

Docker Snake 是一个可以在浏览器运行的贪吃蛇小游戏，也是一个面向初学者的全栈示例。它把 HTML、CSS、JavaScript、Express、PostgreSQL、用户登录、排行榜和本地 Git 管理放在同一个工程中。（本人
不懂前端和后端技术，纯粹是用GPT5.6做出来的网页，所以其实不一定对，这个文档也是写给自己看的）

当前阶段专注于本地开发。项目暂时不包含 Docker 镜像、镜像仓库、GitHub 上传和服务器部署，这些内容可以在理解本地工程后继续学习。

## 已实现功能

- 终端霓虹风格的响应式页面；
- Canvas 贪吃蛇、键盘和触控操作；
- 游客模式及浏览器本地最高分；
- 用户名和密码注册、登录、退出；
- PostgreSQL 持久化用户、Session 和最高分；
- 只记录每个用户的最高分；
- 最多显示 100 人的休闲排行榜；
- 分数归属保护，避免切换账号后串分；
- 请求校验、密码哈希、Session Cookie、限流和统一错误响应；
- 单元测试、HTTP 测试和可选的 PostgreSQL 集成测试。

## 工程结构

```text
docker_snake/
├── client/                  # 浏览器页面、样式和游戏代码
│   ├── index.html
│   ├── scripts/
│   └── styles/
├── server/                  # Express 服务、认证、业务与数据访问
├── db/migrations/           # PostgreSQL 数据库迁移
├── tests/                   # 游戏、前端、服务端和集成测试
├── docs/lessons/            # 01–07 课学习说明
├── .env.example             # 环境变量模板
├── package.json             # 依赖和常用命令
└── vite.config.js           # 前端生产构建配置
```

浏览器只访问 Express 提供的网页和 API。PostgreSQL、密码哈希和排行榜查询都运行在服务器端，用户无法直接访问数据库。

## 环境要求

- Node.js 22 或更高版本；
- npm；
- PostgreSQL 14 或更高版本。

项目的 `engines` 仍兼容现有学习环境中的部分旧版 Node.js，但新安装环境建议直接使用 Node.js 22 或更高版本。

## 快速开始

### 1. 进入工程并安装依赖

```bash
cd ~/docker_snake/.worktrees/full-stack-learning
npm install
```

如果以后把功能分支合并到主目录，请改为进入实际保存 `package.json` 的目录。

### 2. 创建 PostgreSQL 用户和数据库

先进入 PostgreSQL 管理终端：

```bash
sudo -u postgres psql
```

然后执行：

```sql
CREATE ROLE docker_snake WITH LOGIN PASSWORD 'local-dev-password';
CREATE DATABASE docker_snake OWNER docker_snake;
\q
```

上面的密码只适合本机学习。不要把真实服务器密码提交到 Git。

### 3. 创建本地环境变量

```bash
cp .env.example .env
```

生成随机 Session 密钥：

```bash
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
```

编辑 `.env`，至少填写以下内容：

```dotenv
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
DATABASE_URL=postgresql://docker_snake:local-dev-password@localhost:5432/docker_snake
SESSION_SECRET=把刚才生成的随机值粘贴到这里
PUBLIC_ORIGIN=http://localhost:3000
TRUST_PROXY=0
```

`.env` 已被 Git 忽略。可以提交 `.env.example`，但不要提交 `.env`。

### 4. 启动服务器

```bash
npm start
```

启动过程会自动：

1. 检查环境变量；
2. 等待 PostgreSQL 可用；
3. 执行尚未应用的数据库迁移；
4. 创建 Session、API 和静态网页服务；
5. 在 `http://localhost:3000` 提供网站。

在浏览器打开 `http://localhost:3000`。停止服务器时，在终端按 `Ctrl+C`。

开发时也可以使用监听模式：

```bash
npm run dev
```

## 页面使用方法

1. 等待页面左上角完成登录状态检查；
2. 不登录也可以直接开始游戏，最高分保存在浏览器中；
3. 点击「注册」，输入用户名和至少 15 个字符的密码；
4. 登录后完成的游戏会把成绩提交到服务器；
5. 服务器只在新成绩更高时更新最高分；
6. 页面下方可以刷新排行榜并查看自己的真实排名。

游客成绩不会在登录后自动上传。这样可以明确区分本地游客数据与服务器账户数据。

## 常用命令

```bash
# 运行全部自动测试
npm test

# 构建生产前端到 dist/
npm run build

# 启动服务
npm start

# 监听服务端文件变化并重启
npm run dev
```

### PostgreSQL 集成测试

集成测试必须使用独立测试数据库，数据库名必须以 `_test` 或 `-test` 结尾：

```sql
CREATE DATABASE docker_snake_test OWNER docker_snake;
```

运行：

```bash
TEST_DATABASE_URL=postgresql://docker_snake:local-dev-password@localhost:5432/docker_snake_test \
  npm run test:integration
```

未设置 `TEST_DATABASE_URL` 时，测试会安全跳过，不会回退使用开发数据库。

## API 概览

| 方法 | 路径 | 作用 | 是否需要登录 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 检查服务器和数据库状态 | 否 |
| `GET` | `/api/auth/me` | 获取当前登录状态 | 否 |
| `POST` | `/api/auth/register` | 注册并建立 Session | 否 |
| `POST` | `/api/auth/login` | 登录 | 否 |
| `POST` | `/api/auth/logout` | 退出登录 | 是 |
| `POST` | `/api/scores` | 提交一局成绩 | 是 |
| `GET` | `/api/leaderboard` | 获取排行榜和个人排名 | 否 |

写请求使用 JSON，并由浏览器客户端添加 `X-Docker-Snake-Request: 1`。服务端还会检查请求来源，减少跨站请求伪造风险。

## 本地 Git 学习流程

完成一个小步骤后，可以依次执行：

```bash
git status
git diff
git add README.md
git commit -m "docs: 更新学习说明"
git log --oneline --decorate -10
```

建议显式写出要暂存的文件，不要在不了解改动时直接使用 `git add .`。GitHub 远程仓库、`git push` 和 Pull Request 留到后续课程。

## 学习顺序

1. [HTML 页面结构](docs/lessons/01-html.md)
2. [CSS 终端霓虹界面](docs/lessons/02-css.md)
3. [JavaScript 贪吃蛇](docs/lessons/03-javascript-game.md)
4. [HTTP 与 Express](docs/lessons/04-http-express.md)
5. [PostgreSQL 与迁移](docs/lessons/05-postgresql.md)
6. [用户认证与 Session](docs/lessons/06-authentication.md)
7. [最高分与排行榜](docs/lessons/07-leaderboard.md)

每一课只解释一个主要层次。遇到不理解的文件或报错时，再针对该步骤继续排查。

## 常见问题

### 启动后一直等待数据库

确认 PostgreSQL 正在运行，并检查 `.env` 中的主机、端口、用户名、密码和数据库名。

```bash
sudo systemctl status postgresql
```

### 页面可以打开，但注册失败

先访问 `http://localhost:3000/healthz`。如果返回 `503`，优先解决数据库连接问题。

### 提示 `PUBLIC_ORIGIN` 不匹配

浏览器地址和 `.env` 必须一致。例如浏览器使用 `http://localhost:3000` 时，`PUBLIC_ORIGIN` 也应使用这个地址，不要混用 `127.0.0.1`。

### 端口 3000 已被占用

把 `.env` 中的 `PORT` 和 `PUBLIC_ORIGIN` 一起改成其他端口，例如 3001。

### 真实数据库测试显示 `SKIP`

这是安全行为，说明没有设置独立的 `TEST_DATABASE_URL`。普通单元测试仍然会运行。

## 当前边界

本阶段没有创建 `Dockerfile`、Compose 文件或镜像上传脚本，也没有执行 GitHub 上传。等本地应用、数据库和 Git 基础都理解后，再把这个完整工程封装进 Docker 镜像会更容易。
