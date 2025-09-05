# Claude-to-OpenAI API Proxy (Node.js 版本)

这是一个 Node.js Express 服务器，作为 Claude API 和 OpenAI 兼容 API 之间的代理。它可以将 Claude 格式的请求转换为 OpenAI 格式，并将响应转换回 Claude 格式。

## 功能特性

- ✅ 完整支持 `/v1/messages` 端点
- ✅ 正确处理和转换工具调用（函数调用）
- ✅ 支持流式响应（Server-Sent Events）
- ✅ 自动清理 JSON Schema 以兼容严格的 API（如 Google Gemini）
- ✅ 支持图像输入
- ✅ CORS 支持
- ✅ 健康检查端点

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 到 `.env` 并编辑：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# OpenAI API 配置
OPENAI_BASE_URL=http://localhost:8094/v1
OPENAI_API_KEY=your-api-key-here

# 服务器配置
PORT=3000
```

### 3. 启动服务器

#### 开发模式（自动重启）
```bash
npm run dev
```

#### 生产模式
```bash
npm start
```

#### 使用启动脚本
```bash
./start.sh
```

### 4. 测试服务器

服务器启动后，您可以访问：

- 健康检查：http://localhost:3000/health
- API 端点：http://localhost:3000/v1/messages

## API 使用

### 请求格式

发送 POST 请求到 `http://localhost:3000/v1/messages`：

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "model": "gpt-3.5-turbo",
    "max_tokens": 100,
    "messages": [
      {
        "role": "user",
        "content": "Hello, world!"
      }
    ]
  }'
```

### 流式响应

要启用流式响应，在请求中添加 `"stream": true`：

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "model": "gpt-3.5-turbo",
    "max_tokens": 100,
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "Hello, world!"
      }
    ]
  }'
```

## 环境变量

| 变量名 | 描述 | 默认值 |
|--------|------|--------|
| `OPENAI_BASE_URL` | OpenAI 兼容 API 的基础 URL | `http://localhost:8094/v1` |
| `OPENAI_API_KEY` | API 密钥 | 无 |
| `PORT` | 服务器端口 | `3000` |
| `HAIKU_MODEL_NAME` | Haiku 模型名称（可选） | 无 |
| `HAIKU_BASE_URL` | Haiku API 基础 URL（可选） | 无 |
| `HAIKU_API_KEY` | Haiku API 密钥（可选） | 无 |

## 部署

### Docker 部署

创建 `Dockerfile`：

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
```

构建和运行：

```bash
docker build -t claude-proxy .
docker run -p 3000:3000 --env-file .env claude-proxy
```

### PM2 部署

```bash
npm install -g pm2
pm2 start src/index.js --name claude-proxy
pm2 save
pm2 startup
```

### 系统服务

创建 `/etc/systemd/system/claude-proxy.service`：

```ini
[Unit]
Description=Claude Proxy
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/claude-proxy
ExecStart=/usr/bin/node src/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl enable claude-proxy
sudo systemctl start claude-proxy
```

## 故障排除

### 常见问题

1. **端口被占用**
   ```bash
   # 查看端口占用
   lsof -i :3000
   # 或更改端口
   PORT=3001 npm start
   ```

2. **API 密钥错误**
   - 检查 `.env` 文件中的 `OPENAI_API_KEY` 是否正确
   - 确保请求头中包含正确的 `x-api-key`

3. **连接被拒绝**
   - 检查 `OPENAI_BASE_URL` 是否正确
   - 确保目标 API 服务器正在运行

### 日志

服务器会在控制台输出详细的错误信息。在生产环境中，建议使用 PM2 或类似的进程管理器来管理日志。

## 开发

### 项目结构

```
├── src/
│   └── index.ts          # 主服务器文件
├── package.json          # 项目配置
├── tsconfig.json         # TypeScript 配置
├── .env.example          # 环境变量示例
├── start.sh              # 启动脚本
└── README_NODEJS.md      # 说明文档
```

### 开发命令

```bash
# 安装依赖
npm install

# 开发模式（自动重启）
npm run dev

# 构建 TypeScript
npm run build

# 生产模式
npm start
```

## 许可证

MIT License

## Docker 部署

### 使用 Docker 构建和运行

#### 方法一：使用构建脚本（推荐）

```bash
# 构建并启动 Docker 容器
./docker-build.sh
```

#### 方法二：手动 Docker 命令

```bash
# 构建镜像
docker build -t claude-proxy:latest .

# 运行容器
docker run -d \
    --name claude-proxy \
    --env-file .env \
    -p 8787:8787 \
    --restart unless-stopped \
    claude-proxy:latest
```

#### 方法三：使用 Docker Compose

```bash
# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

### Docker 管理命令

```bash
# 查看运行状态
docker ps

# 查看日志
docker logs claude-proxy

# 停止容器
docker stop claude-proxy

# 重启容器
docker restart claude-proxy

# 删除容器
docker rm claude-proxy

# 删除镜像
docker rmi claude-proxy:latest
```

### 跨平台支持

Dockerfile 支持以下平台：
- `linux/amd64` (Intel/AMD 64位)
- `linux/arm64` (ARM 64位，如 Apple Silicon Mac)

### 环境变量

在 `.env` 文件中配置以下变量：

```env
# OpenAI API 配置
OPENAI_BASE_URL=http://localhost:8094/v1
OPENAI_API_KEY=your-api-key-here

# 服务器配置
PORT=8787

# 可选：Haiku 模型配置
HAIKU_MODEL_NAME=快速的模型
HAIKU_BASE_URL=https://url/v1
HAIKU_API_KEY=sk-**
```

### 生产环境部署

#### 使用 Docker Compose（推荐）

1. 配置 `.env` 文件
2. 运行 `docker-compose up -d`
3. 服务将在后台运行，自动重启

#### 使用 Docker Swarm

```bash
# 初始化 Swarm
docker swarm init

# 部署服务
docker stack deploy -c docker-compose.yml claude-proxy

# 查看服务状态
docker service ls
```

#### 使用 Kubernetes

创建 `k8s-deployment.yaml`：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claude-proxy
spec:
  replicas: 3
  selector:
    matchLabels:
      app: claude-proxy
  template:
    metadata:
      labels:
        app: claude-proxy
    spec:
      containers:
      - name: claude-proxy
        image: claude-proxy:latest
        ports:
        - containerPort: 8787
        env:
        - name: OPENAI_BASE_URL
          value: "http://your-openai-api:8094/v1"
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: claude-proxy-secrets
              key: openai-api-key
---
apiVersion: v1
kind: Service
metadata:
  name: claude-proxy-service
spec:
  selector:
    app: claude-proxy
  ports:
  - port: 8787
    targetPort: 8787
  type: LoadBalancer
```

### 性能优化

#### 多阶段构建优化

如果需要更小的镜像，可以使用多阶段构建：

```dockerfile
# 构建阶段
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# 运行阶段
FROM node:18-alpine AS runner
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S claude-proxy -u 1001
COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm install -g typescript ts-node
USER claude-proxy
EXPOSE 8787
CMD ["ts-node", "src/index.ts"]
```

#### 资源限制

在 `docker-compose.yml` 中添加资源限制：

```yaml
services:
  claude-proxy:
    # ... 其他配置
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 256M
```

### 监控和日志

#### 日志管理

```bash
# 查看实时日志
docker logs -f claude-proxy

# 限制日志大小
docker run --log-opt max-size=10m --log-opt max-file=3 claude-proxy:latest
```

#### 健康检查

容器内置健康检查，每30秒检查一次：

```bash
# 查看健康状态
docker inspect --format='{{.State.Health.Status}}' claude-proxy
```

### 故障排除

#### 常见问题

1. **容器启动失败**
   ```bash
   # 查看详细错误
   docker logs claude-proxy
   ```

2. **端口冲突**
   ```bash
   # 更改端口映射
   docker run -p 8788:8787 claude-proxy:latest
   ```

3. **环境变量问题**
   ```bash
   # 检查环境变量
   docker exec claude-proxy env
   ```

4. **网络连接问题**
   ```bash
   # 测试网络连接
   docker exec claude-proxy ping google.com
   ```

