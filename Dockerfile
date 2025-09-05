# 使用官方 Node.js 18 Alpine 镜像作为基础镜像
# Alpine 镜像体积小，安全性高，适合生产环境
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装必要的系统依赖
RUN apk add --no-cache \
    dumb-init \
    && rm -rf /var/cache/apk/*

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S claude-proxy -u 1001

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装所有依赖（包括开发依赖，用于 TypeScript 编译）
RUN npm ci && npm cache clean --force

# 复制源代码和配置文件
COPY src/ ./src/
COPY tsconfig.json ./

# 设置文件权限
RUN chown -R claude-proxy:nodejs /app
USER claude-proxy

# # 暴露端口
# EXPOSE 8092

# # 设置环境变量
# ENV NODE_ENV=production
# ENV PORT=8092

# # 健康检查
# HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
#     CMD node -e "require('http').get('http://localhost:8092/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# 使用 dumb-init 作为 PID 1，正确处理信号
ENTRYPOINT ["dumb-init", "--"]

# 启动应用
CMD ["npx", "ts-node", "src/index.ts"]
