# XgoatCast 部署指南

## 前置条件

- 服务器安装 Docker 和 Docker Compose
- 开放 3520 端口（或自定义 `PORT`）
- KOOK 机器人 Token（在 [KOOK 开发者中心](https://developer.kookapp.cn/) 创建机器人获取）

## 部署步骤

### 1. 配置环境变量

```bash
cp .env.example .env
vim .env
```

必须填写：

| 变量 | 说明 |
|------|------|
| `SUPER_ADMIN_PASSWORD` | **必填**，超级管理员登录密码 |
| `PORT` | 服务端口，默认 3520 |
| `PUBLIC_DOMAIN` | 对外可访问域名（如 `https://share.example.com`） |

> Agora 凭证和 KOOK Bot Token 不在环境变量配置——机器人加入服务器后，由频道主在管理面板中为每个服务器独立配置。

### 2. 构建并启动

```bash
# 构建前端 + 后端
npm run build

# 启动 Docker 容器
docker compose up -d --build
```

### 3. 配置超管面板

1. 访问 `http://你的域名:3520/super`
2. 使用 `SUPER_ADMIN_PASSWORD` 登录
3. 在「全局配置」中填入 KOOK Bot Token 和公网域名
4. 邀请机器人到 KOOK 服务器，机器人会自动同步服务器列表

### 4. 服务器绑定（频道主操作）

1. 机器人加入后自动向频道主发送绑定卡片
2. 若未收到，频道主在 KOOK 频道发送 `/xchelp` 调起绑定
3. 点击绑定卡片 → 设置管理密码 → 配置 Agora App ID 和 App Certificate

### 5. 开始使用

频道内发送触发词（默认「屏幕共享」）→ 机器人推送卡片 → 点击开始共享。

## 反向代理（推荐）

```nginx
server {
    listen 80;
    server_name share.example.com;

    location / {
        proxy_pass http://127.0.0.1:3520;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;

        # SSE 支持
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 管理命令

```bash
# 查看日志
docker compose logs -f

# 重启
docker compose restart

# 停止
docker compose down
```
