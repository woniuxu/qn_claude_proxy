#!/bin/bash

# --- 使用说明 ---
#
# 本脚本用于配置 Claude Code (claude.ai/code) 命令行工具，
# 使其通过一个代理服务来访问大语言模型。
#
# ## 功能:
# 1. 检查并安装 Claude Code。
# 2. 自动配置 `~/.claude/settings.json` 文件，设置代理所需的 API 地址和密钥。
# 3. 支持使用 `jq` 或 `python3` 更新 JSON 配置，如果两者都不可用，则会覆盖配置文件。
# 4. 在更新配置前，会自动备份旧的 `settings.json` 文件。
#
# ## 如何使用:
# 1. **修改变量**:
#    - 打开此脚本 (`claude_proxy.sh`)。
#    - 找到 "重点: 需要替换的内容" 部分。
#    - `API_KEY`: 填入你的 API 密钥。
#    - `OPEN_AI_URL`: 填入你的代理服务地址 (例如: "tbai.xin/v1")。
#    - `OPEN_MODEL`: 填入你希望使用的模型名称 (例如: "gemini-1.5-pro")。
#
# 2. **运行脚本**:
#    - 保存修改。
#    - 在终端中执行 `./claude_proxy.sh`。
#
# 3. **完成**:
#    - 脚本会自动完成所有配置。
#    - 现在你可以在命令行中使用 `claude` 命令，它将通过你配置的代理进行通信。
#
# ## 注意:
# - 请确保已安装 Node.js 和 npm，因为脚本可能需要使用 npm 来安装 Claude Code。
# - 脚本会修改你主目录下的 `.claude/settings.json` 文件。
#


## 交互式配置

# 默认值
DEFAULT_WORKER_URL="https://claude-code-proxy.suixifa.workers.dev"
DEFAULT_API_KEY="sk-"
DEFAULT_OPEN_AI_URL="tbai.xin/v1"
DEFAULT_OPEN_MODEL="gemini-2.5-pro"

# 提示用户输入配置
echo "=== Claude Code 代理配置 ==="
echo

read -p "请输入 Worker URL [默认: $DEFAULT_WORKER_URL]: " input_worker_url
WORKER_URL="${input_worker_url:-$DEFAULT_WORKER_URL}"

read -p "请输入 API Key [默认: $DEFAULT_API_KEY]: " input_api_key
API_KEY="${input_api_key:-$DEFAULT_API_KEY}"

read -p "请输入 OpenAI URL (不带http协议) [默认: $DEFAULT_OPEN_AI_URL]: " input_open_ai_url
OPEN_AI_URL="${input_open_ai_url:-$DEFAULT_OPEN_AI_URL}"

read -p "请输入模型名称 [默认: $DEFAULT_OPEN_MODEL]: " input_open_model
OPEN_MODEL="${input_open_model:-$DEFAULT_OPEN_MODEL}"

echo
echo "配置确认:"
echo "Worker URL: $WORKER_URL"
echo "API Key: ${API_KEY:0:10}..." 
echo "OpenAI URL: $OPEN_AI_URL"
echo "模型: $OPEN_MODEL"
echo

read -p "确认配置? (y/N): " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "配置已取消"
    exit 0
fi

# --- 常量 ---
# 定义脚本所需的常量
readonly CLAUDE_COMMAND="claude"
readonly NPM_PACKAGE="@anthropic-ai/claude-code"
readonly CLAUDE_DIR="$HOME/.claude"
readonly SETTINGS_FILE="$CLAUDE_DIR/settings.json"



readonly BASE_URL="$WORKER_URL/$OPEN_AI_URL/$OPEN_MODEL"
readonly API_KEY_HELPER="echo '$API_KEY'"

# --- 主脚本 ---

# 提示正在检查 Claude Code 是否已安装
echo "Checking for Claude Code installation..."

# 检查 claudecode 命令是否存在
if command -v "$CLAUDE_COMMAND" &> /dev/null; then
    # 如果存在，则打印一条消息
    echo "Claude Code is already installed."
else
    # 如果不存在，则提示开始安装
    echo "Claude Code not found. Installing..."

    # 检查 npm 是否可用
    if ! command -v npm &> /dev/null; then
        # 如果不可用，则打印错误并退出
        echo "Error: npm is not installed. Please install Node.js first."
        exit 1
    fi

    # 使用 npm 安装 Claude Code
    echo "Installing Claude Code via npm..."
    if ! npm install -g "$NPM_PACKAGE"; then
        # 如果安装失败，则打印错误并退出
        echo "Error: Failed to install Claude Code."
        exit 1
    fi

    # 提示安装成功
    echo "Claude Code installed successfully."
fi

# 提示开始配置
echo "Setting up Claude Code configuration..."

# 如果 .claude 目录不存在，则创建它
if [ ! -d "$CLAUDE_DIR" ]; then
    mkdir -p "$CLAUDE_DIR"
fi

# 检查 settings.json 是否已存在
if [ -f "$SETTINGS_FILE" ]; then
    # 如果存在，则提示开始更新
    echo "Settings file exists. Updating API configuration..."

    # 创建配置文件的备份
    cp "$SETTINGS_FILE" "$SETTINGS_FILE.backup"

    # 检查是否安装了 jq 用于操作 JSON
    if command -v jq &> /dev/null; then
        # 使用 jq 修改 JSON 文件
        # 它会备份旧的 API 密钥和 URL，并设置新的值
        jq --arg apiKey "$API_KEY" --arg baseUrl "$BASE_URL" --arg apiKeyHelper "$API_KEY_HELPER" \
           '.env.ANTHROPIC_API_KEY_OLD = .env.ANTHROPIC_API_KEY | .env.ANTHROPIC_BASE_URL_OLD = .env.ANTHROPIC_BASE_URL | .env.ANTHROPIC_API_KEY = $apiKey | .env.ANTHROPIC_BASE_URL = $baseUrl | .apiKeyHelper = $apiKeyHelper' \
           "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp" && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
    else
        # 如果未找到 jq，则尝试使用 Python
        echo "jq not found, attempting to use Python for modification..."

        # 检查 python3 是否可用
        if command -v python3 &> /dev/null; then
            # 使用 Python 脚本修改 JSON 文件
            python3 -c "
import json
import sys

settings_file = '$SETTINGS_FILE'
api_key = '$API_KEY'
base_url = '$BASE_URL'
api_key_helper = '$API_KEY_HELPER'

with open(settings_file, 'r') as f:
    try:
        data = json.load(f)
    except json.JSONDecodeError:
        # 如果文件为空或无效，则创建一个默认结构
        data = {'env': {}, 'permissions': {'allow': [], 'deny': {}}, 'apiKeyHelper': ''}

# 如果旧值存在，则进行备份
if 'env' in data and 'ANTHROPIC_API_KEY' in data['env']:
    data['env']['ANTHROPIC_API_KEY_OLD'] = data['env'].get('ANTHROPIC_API_KEY')
if 'env' in data and 'ANTHROPIC_BASE_URL' in data['env']:
    data['env']['ANTHROPIC_BASE_URL_OLD'] = data['env'].get('ANTHROPIC_BASE_URL')

# 设置新值
if 'env' not in data:
    data['env'] = {}
data['env']['ANTHROPIC_API_KEY'] = api_key
data['env']['ANTHROPIC_BASE_URL'] = base_url
data['apiKeyHelper'] = api_key_helper

with open(settings_file, 'w') as f:
    json.dump(data, f, indent=2)
"
        else
            # 如果 jq 和 python3 都没有找到，则覆盖配置文件
            echo "Warning: Neither jq nor python3 found. Overwriting settings file."
            cat > "$SETTINGS_FILE" << EOF
{
  "env": {
    "ANTHROPIC_API_KEY": "$API_KEY",
    "ANTHROPIC_BASE_URL": "$BASE_URL"
  },
  "permissions": {
    "allow": [],
    "deny": []
  },
  "apiKeyHelper": "$API_KEY_HELPER"
}
EOF
        fi
    fi

    # 提示更新成功
    echo "Updated existing settings file with new API configuration."
    echo "Original values backed up with _OLD suffix."
else
    # 如果 settings.json 不存在，则创建一个新的
    echo "Creating new settings.json..."
    cat > "$SETTINGS_FILE" << EOF
{
  "env": {
    "ANTHROPIC_API_KEY": "$API_KEY",
    "ANTHROPIC_BASE_URL": "$BASE_URL"
  },
  "permissions": {
    "allow": [],
    "deny": []
  },
  "apiKeyHelper": "$API_KEY_HELPER"
}
EOF
    # 提示创建成功
    echo "Created new settings file."
fi

# 提示配置完成
echo "Configuration complete!"
echo "Settings saved to: $SETTINGS_FILE"

# 测试代理连接
echo
echo "=== 测试代理连接 ==="
echo "正在测试代理连接..."

# 构建测试请求
TEST_URL="$BASE_URL/v1/messages"
TEST_HEADERS="Content-Type: application/json"
TEST_DATA='{
  "model": "'"$OPEN_MODEL"'",
  "max_tokens": 10,
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ]
}'

# 使用curl测试连接
echo "测试URL: $TEST_URL"
echo "使用curl测试代理连接..."
echo

curl_response=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "$TEST_HEADERS" \
  -H "x-api-key: $API_KEY" \
  -d "$TEST_DATA" \
  "$TEST_URL")

# 提取HTTP状态码
http_code=$(echo "$curl_response" | tail -n1)
response_body=$(echo "$curl_response" | sed '$d')

if [ "$http_code" = "200" ]; then
    echo "✅ 代理连接成功！"
    echo "响应: $response_body"
else
    echo "❌ 代理连接失败"
    echo "HTTP状态码: $http_code"
    echo "响应: $response_body"
fi

echo
echo "现在可以使用 'claude' 命令通过代理访问模型了！"
