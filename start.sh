#!/bin/bash

# Claude Proxy 启动脚本

echo "🚀 启动 Claude Proxy 服务器..."

# 检查是否存在 .env 文件
if [ ! -f .env ]; then
    echo "⚠️  未找到 .env 文件，正在从 .env.example 创建..."
    cp .env.example .env
    echo "📝 请编辑 .env 文件配置您的 API 密钥和设置"
    echo "   然后重新运行此脚本"
    exit 1
fi

# 检查是否安装了依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖包..."
    npm install
fi

# 检查端口是否被占用
PORT=${PORT:-8092}
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "⚠️  端口 $PORT 已被占用，正在尝试停止现有进程..."
    pkill -f "ts-node src/index.ts" 2>/dev/null || true
    sleep 2
fi

# 启动服务器
echo "🌟 启动服务器在端口 $PORT..."
echo "📡 健康检查: http://localhost:$PORT/health"
echo "🔗 API 端点: http://localhost:$PORT/v1/messages"
echo ""
echo "按 Ctrl+C 停止服务器"
echo ""

npm run dev
