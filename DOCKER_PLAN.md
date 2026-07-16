# Docker Snake 镜像方案

## 目标

- 构建一个应用镜像，包含编译后的网页、Express 后端和数据库迁移文件。
- PostgreSQL 使用独立容器，数据库数据保存在 Docker Volume 中。
- 将应用镜像上传到 Docker Hub：`<Docker Hub 用户名>/docker-snake:v0.1.0`。

## 需要添加的文件

- `Dockerfile`：使用 Node.js 多阶段构建，减小最终镜像体积。
- `.dockerignore`：排除 `.env`、Git 文件、`node_modules` 和本地构建产物。
- `compose.yaml`：同时启动应用容器、PostgreSQL 容器和数据库 Volume。

## 执行顺序

1. 编写 `.dockerignore`。
2. 编写并理解 `Dockerfile`。
3. 构建带版本号的应用镜像。
4. 使用 Docker Compose 在本地启动应用和 PostgreSQL。
5. 检查首页、`/healthz`、注册、登录和排行榜。
6. 登录 Docker Hub，上传 `v0.1.0` 标签。
7. 删除本地测试镜像，再从 Docker Hub 拉取并重新运行。

## 安全边界

- 不把 `.env`、数据库密码和 Session 密钥放进镜像。
- 不把 PostgreSQL 数据打包进应用镜像。
- 本地验证成功后才能上传。
- 使用 `v0.1.0` 等明确版本；`latest` 只作为辅助标签。
