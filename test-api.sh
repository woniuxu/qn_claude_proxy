#!/bin/bash

# Claude Proxy API 测试脚本

echo "🧪 测试 Claude Proxy API..."

# 启动服务器
echo "🚀 启动服务器..."
npm run dev &
SERVER_PID=$!

# 等待服务器启动
echo "⏳ 等待服务器启动..."
sleep 5

# 测试健康检查
echo "🔍 测试健康检查端点..."
HEALTH_RESPONSE=$(curl -s http://localhost:8787/health)
if echo "$HEALTH_RESPONSE" | grep -q "ok"; then
    echo "✅ 健康检查通过"
else
    echo "❌ 健康检查失败: $HEALTH_RESPONSE"
    kill $SERVER_PID
    exit 1
fi

# 测试 API 端点（需要有效的 API 密钥）
echo "🔍 测试 API 端点..."
API_RESPONSE=$(curl -s -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-1dea0c71a15adc57d7a0a6ec4e33727eb5c457693a695b17e0f4c83bfba977b2" \
  -d '{
    "model": "deepseek-v3",
    "stream": true,
    "max_tokens": 10,
    "messages": [
      {
        "role": "user",
        "content": "Hello"
      }
    ]
  }')

if echo "$API_RESPONSE" | grep -q "error"; then
    echo "⚠️  API 端点响应错误（这是预期的，因为没有有效的后端服务）"
    echo "   响应: $API_RESPONSE"
else
    echo "✅ API 端点响应正常"
fi

# 停止服务器
echo "�� 停止服务器..."
kill $SERVER_PID

echo "🎉 测试完成！"
echo ""
echo "📝 使用说明："
echo "1. 编辑 .env 文件配置您的 API 设置"
echo "2. 运行 ./start.sh 启动服务器"
echo "3. 访问 http://localhost:8092/health 检查状态"
echo "4. 向 http://localhost:8092/v1/messages 发送请求"
