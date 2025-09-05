#!/bin/bash

# Claude Proxy Docker 构建和运行脚本

echo "🐳 Claude Proxy Docker 构建脚本"

# 检查 Docker 是否安装
if ! command -v docker &> /dev/null; then
    echo "❌ Docker 未安装，请先安装 Docker"
    exit 1
fi

# 检查是否存在 .env 文件
if [ ! -f .env ]; then
    echo "⚠️  未找到 .env 文件，正在从 .env.example 创建..."
    cp .env.example .env
    echo "📝 请编辑 .env 文件配置您的 API 密钥和设置"
    echo "   然后重新运行此脚本"
    exit 1
fi

# 构建 Docker 镜像
echo "🔨 构建 Docker 镜像..."
docker build -t claude-proxy:latest .

if [ $? -eq 0 ]; then
    echo "✅ Docker 镜像构建成功"
else
    echo "❌ Docker 镜像构建失败"
    exit 1
fi

# 停止并删除现有容器（如果存在）
echo "🛑 停止现有容器..."
docker stop claude-proxy 2>/dev/null || true
docker rm claude-proxy 2>/dev/null || true

# 运行容器
echo "🚀 启动容器..."
docker run -d \
    --name claude-proxy \
    --env-file .env \
    -p 8092:8092 \
    --restart unless-stopped \
    claude-proxy:latest

if [ $? -eq 0 ]; then
    echo "✅ 容器启动成功"
    echo ""
    echo "📡 服务信息："
    echo "   健康检查: http://localhost:8092/health"
    echo "   API 端点: http://localhost:8092/v1/messages"
    echo ""
    echo "🔍 查看日志: docker logs claude-proxy"
    echo "🛑 停止服务: docker stop claude-proxy"
    echo "🗑️  删除容器: docker rm claude-proxy"
else
    echo "❌ 容器启动失败"
    exit 1
fi
