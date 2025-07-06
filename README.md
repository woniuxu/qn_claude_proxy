
# Claude-to-OpenAI API 代理

这是一个部署在 Cloudflare Workers 上的 TypeScript 项目，它充当一个代理服务器，能够将 [Claude API](https://docs.anthropic.com/claude/reference/messages_post) 格式的请求转换为 [OpenAI API](https://platform.openai.com/docs/api-reference/chat/create) 格式。这使得任何与 Claude API 兼容的客户端（例如 [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code)）都能够与任何支持 OpenAI API 格式的服务进行通信。

## ✨ 功能特性

- **动态路由**: 无需修改代码，即可将请求代理到任意 OpenAI 兼容的 API 端点。API 的目标地址和模型名称可以直接在请求 URL 中指定。
- **Claude API 兼容**: 完全支持 `/v1/messages` 端点，包括流式响应和非流式响应。
- **Tool Calling (函数调用)转换**: 自动将 Claude 的 `tools` 格式转换为 OpenAI 的格式，并对 `input_schema` 进行清理，以确保与 Google Gemini 等严格的 API 兼容。
- **Haiku 模型快捷方式**: 通过环境变量，为特定的 "Haiku" 模型配置了固定的路由，方便快速调用。
- **简易配置脚本**: 提供 `claude_proxy.sh` 脚本，帮助用户一键配置本地的 Claude Code CLI，以使用此代理。
- **轻松部署**: 可以一键部署到 Cloudflare Workers 全球网络。

## 🚀 快速上手 (推荐)

如果你不想自己部署，可以直接使用脚本中预配置的公共代理服务。这是最简单快捷的使用方式。

1.  **打开配置脚本**:
    在你的代码编辑器中打开 `claude_proxy.sh` 文件。

2.  **修改变量**:
    找到 "重点: 需要替换的内容" 部分，并根据你的需求修改以下三个变量：
    - `API_KEY`: **你的目标服务 API 密钥**。例如，如果你想使用 Groq，这里就填你的 Groq API Key。这个密钥会通过 `x-api-key` 头安全地发送给代理，并最终由代理转发给目标服务。
    - `OPEN_AI_URL`: **你的目标服务 API 地址**。例如，Groq 的地址是 `api.groq.com/openai/v1`。
    - `OPEN_MODEL`: **你希望使用的模型名称**，例如 `llama3-70b-8192`。

    **示例**:
    ```bash
    # claude_proxy.sh

    ## 重点: 需要替换的内容
    # key
    readonly API_KEY="gsk_YourGroqAPIKey" # 你的 Groq API Key
    readonly OPEN_AI_URL="api.groq.com/openai/v1" # 目标 API 地址
    # 模型
    readonly OPEN_MODEL="llama3-70b-8192" # 目标模型
    ```

3.  **运行脚本**:
    在终端中执行脚本以完成配置。
    ```bash
    chmod +x ./claude_proxy.sh
    ./claude_proxy.sh
    ```

4.  **完成**!
    脚本会自动配置好 `~/.claude/settings.json`。现在你可以直接使用 `claude` 命令，它将通过公共代理与你指定的目标服务通信。

## 🛠️ 进阶用法：自托管部署

如果你希望拥有自己的代理服务，可以按照以下步骤将此项目部署到你自己的 Cloudflare 账户。

### 步骤 1: 部署到 Cloudflare

1.  **安装 Wrangler CLI**:
    [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) 是 Cloudflare 的官方命令行工具。
    ```bash
    npm install -g wrangler
    ```

2.  **配置 `wrangler.toml` (可选)**:
    你可以修改 `wrangler.toml` 文件中的 `[vars]` 部分，为 "Haiku" 模型设置一个备用或默认的 API 端点。
    ```toml
    # wrangler.toml
    [vars]
    HAIKU_MODEL_NAME = "gpt-4o-mini"
    HAIKU_BASE_URL   = "https://api.your-provider.com/v1"
    HAIKU_API_KEY    = "sk-your-secret-key"
    ```

3.  **部署**:
    在项目根目录下运行以下命令：
    ```bash
    npx wrangler deploy
    ```
    部署成功后，你将获得一个 `*.workers.dev` 的域名，例如 `my-proxy.workers.dev`。这就是你自己的代理地址。

### 步骤 2: 配置 `claude_proxy.sh` 使用自托管代理

部署完成后，你需要配置 `claude_proxy.sh` 脚本来使用你自己的代理地址。

1.  **修改脚本**: 打开 `claude_proxy.sh`。
2.  **修改变量**:
    - `API_KEY`: 你的目标服务 API 密钥。
    - `OPEN_AI_URL`: **你的 Worker 地址** 和 **目标 API 地址** 的组合。格式为 `<你的-worker-域名>/https/<目标API域名>/<路径>`。
    - `OPEN_MODEL`: 你希望使用的模型名称。

    **示例**:
    假设你的 Worker 部署在 `my-proxy.workers.dev`，你想访问 Groq API (`api.groq.com/openai/v1`)。
    ```bash
    # claude_proxy.sh
    readonly API_KEY="gsk_YourGroqAPIKey"
    readonly OPEN_AI_URL="my-proxy.workers.dev/https/api.groq.com/openai/v1" # 注意这里的变化
    readonly OPEN_MODEL="llama3-70b-8192"
    ```

3.  **运行脚本**:
    ```bash
    ./claude_proxy.sh
    ```

## 🔬 工作原理

### 动态路由

本代理最核心的功能是动态路由。它通过解析请求 URL 来确定最终的目标 API 和模型。

URL 格式:
`https://<代理地址>/<协议>/<目标API域名>/<路径>/<模型名称>/v1/messages`

当一个请求发送到代理时，它会：
1.  解析 URL，提取出目标 Base URL 和模型名称。
2.  将请求头中的 `x-api-key` 作为 `Authorization: Bearer <key>` 转发给目标 API。
3.  将 Claude 格式的请求体转换为 OpenAI 格式，然后发送到目标的 `/chat/completions` 端点。
4.  将收到的 OpenAI 格式响应转换回 Claude 格式，并返回给客户端。

## 💻 本地开发

如果你想在本地运行和测试此 Worker，可以使用以下命令：

```bash
npx wrangler dev
```

这将在本地启动一个服务器（通常是 `http://localhost:8787`），你可以用它来进行开发和调试。

**注意**: 在本地开发时，你需要创建一个 `.dev.vars` 文件来存储环境变量，否则 Worker 无法获取 `wrangler.toml` 中定义的 `[vars]`。

**`.dev.vars` 文件示例**:
```
HAIKU_MODEL_NAME="gpt-4o-mini"
HAIKU_BASE_URL="https://api.your-provider.com/v1"
HAIKU_API_KEY="sk-your-secret-key"
```
