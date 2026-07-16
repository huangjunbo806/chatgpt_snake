# 2026-07-15 学习记录

## 1. 数据库和网站的启动

- 安装并启动了 PostgreSQL 服务。
- 进入 PostgreSQL 管理终端，创建了项目使用的角色和数据库。
- 明确了 PostgreSQL 角色与网站注册用户是两类不同账号。
- 配置了本地环境变量，启动 Node.js 网站并通过浏览器访问。
- 了解了网站启动时会检查数据库、执行迁移并提供网页和 API。

## 2. GitHub 的使用

- 创建了 GitHub 仓库 `huangjunbo806/chatgpt_snake`。
- 配置了 SSH 公钥，并使用 `ssh -T git@github.com` 验证成功。
- 为本地仓库设置了远程地址 `origin`，并把代码推送到 `main`。
- 在 GitHub 网页修改 README 后，使用 `git fetch` 和 `git merge --ff-only origin/main` 拉取更新。
- 合并了本地分支，并让本地 `main` 跟踪远程 `origin/main`。
- 初步理解了本地分支、远程分支和上游跟踪关系。

## 3. 对公网部署的尝试

- 安装了适用于 x86_64（amd64）的 `cloudflared`。
- 了解了 Cloudflare Quick Tunnel 可以生成临时公网网址，但本地电脑和程序必须持续运行。
- 创建了 Neon PostgreSQL 项目，用于尝试保存公网网站数据。
- 在 Render 导入 GitHub 仓库，填写了构建命令、启动命令和环境变量。
- Render 的 Free 实例仍要求账户添加银行卡，因此没有继续部署。
- 当前暂停公网部署，下一步先学习构建、运行和上传 Docker 镜像。

> 本记录不保存密码、数据库连接串、Session 密钥或其他敏感信息。
