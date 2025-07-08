# Claude-to-OpenAI API 代理

這是一個部署在 Cloudflare Workers 上的 TypeScript 專案，它充當一個代理伺服器，能夠將 [Claude API](https://docs.anthropic.com/claude/reference/messages_post) 格式的請求無縫轉換為 [OpenAI API](https://platform.openai.com/docs/api-reference/chat/create) 格式。 這使得任何與 Claude API 兼容的客戶端（例如官方的 `@anthropic-ai/claude-code` CLI）都能夠與任何支援 OpenAI API 格式的服務進行通信，如 Google Gemini, Groq, Ollama 等。

## ✨ 功能特性

  - **動態路由**: 無需修改或重新部署程式碼，即可將請求代理到任意 OpenAI 兼容的 API 端點。 目標 API 的地址和模型名稱可以直接在請求的 URL 路徑中動態指定。
  - **全功能 API 兼容**: 完全支援 Claude 的 `/v1/messages` 端點，包括流式 (streaming) 和非流式響應。
  - **Tool Calling (函數調用)轉換**: 自動且智能地將 Claude 的 `tools` 格式轉換為 OpenAI 的格式。 同時會對 `input_schema` 進行清理，以確保與 Google Gemini 等要求嚴格的 API 兼容。
  - **Haiku 模型快捷方式**: 可透過 Cloudflare 的環境變數，為特定的 "Haiku" 模型配置一個固定的路由，方便快速調用。
  - **一鍵配置腳本**: 提供 `claude_proxy.sh` 腳本，透過互動式問答，引導使用者一鍵完成本地 `claude` CLI 工具的安裝與配置。
  - **輕鬆部署**: 可以一鍵將服務部署到 Cloudflare Workers 的全球網路。

## 🔬 工作原理：神奇的動態路由

本代理最核心的功能是其動態路由機制。 它透過解析請求的 URL 來決定最終要訪問的目標 API 和模型。

**URL 格式**:
`https://<你的代理地址>/<協議>/<目標API域名>/<路徑>/<模型名稱>/v1/messages`

**處理流程**:

1.  當一個請求發送到代理地址時，代理會解析 URL，從中提取出目標服務的 Base URL (例如 `https://api.groq.com/openai/v1`) 和模型名稱 (例如 `llama3-70b-8192`)。
2.  代理會將請求標頭 (Header) 中的 `x-api-key` 作為 `Authorization: Bearer <key>` 轉發給目標 API。
3.  代理將 Claude 格式的請求體 (Body) 轉換為 OpenAI 格式，然後發送到目標的 `/chat/completions` 端點。
4.  最後，代理將收到的 OpenAI 格式響應轉換回 Claude 格式，並返回給原始的客戶端。

## 🚀 快速上手

我們強烈推薦使用 `claude_proxy.sh` 腳本來進行配置，它會自動處理所有設定。

### 步驟 1: 執行配置腳本

打開您的終端機，直接執行以下命令：

```bash
chmod +x ./claude_proxy.sh
./claude_proxy.sh
```

### 步驟 2: 跟隨互動提示進行設定

腳本將會引導您完成設定，您需要輸入以下資訊：

1.  **Worker URL**: 您的代理服務地址。如果您尚未部署自己的服務，可以直接使用預設的公共地址 (`https://claude-code-proxy.suixifa.workers.dev`)。
2.  **API Key**: **您的目標服務 API 金鑰**。例如，如果您想使用 Groq，這裡就填寫您的 Groq API Key。
3.  **OpenAI URL**: **您的目標服務 API 地址** (不含 `http(s)://` 協議頭)。例如，Groq 的地址是 `api.groq.com/openai/v1`。
4.  **模型名稱**: 您希望使用的模型，例如 `llama3-70b-8192`。

腳本會自動檢查並安裝 `claude` 命令列工具，並將您的設定寫入 `~/.claude/settings.json`。 完成後，腳本還會發送一個測試請求來驗證代理連線是否成功。

### 步驟 3: 開始使用！

配置完成後，您就可以直接在終端機中使用 `claude` 命令，它將通過您設定的代理與指定的模型進行通訊。

```bash
claude "你好，世界！"
```

## 🛠️ 進階用法：自托管部署

如果您希望擁有自己的代理服務，可以按照以下步驟將此專案部署到您自己的 Cloudflare 帳戶。

### 1\. 部署到 Cloudflare

1.  **安裝 Wrangler**: Wrangler 是 Cloudflare 的官方命令列工具。
    ```bash
    npm install -g wrangler
    ```
2.  **配置 `wrangler.toml` (可選)**:
    您可以修改 `wrangler.toml` 文件中的 `[vars]` 部分，為 "Haiku" 模型設定一個備用或預設的 API 端點。
3.  **登入並部署**:
    ```bash
    npx wrangler login
    npx wrangler deploy
    ```
    部署成功後，您將獲得一個 `*.workers.dev` 的域名，例如 `my-proxy.workers.dev`。這就是您自己的代理服務地址。

### 2\. 配置客戶端使用自托管代理

部署完成後，再次執行 `claude_proxy.sh` 腳本，並在提示時輸入您自己的 Worker URL 即可。

## 💻 本地開發

如果您想在本地端運行和測試此 Worker：

1.  **創建 `.dev.vars` 文件**: 在本地開發時，Wrangler 需要一個 `.dev.vars` 文件來讀取環境變數。 內容範例如下：
    ```
    HAIKU_MODEL_NAME="gpt-4o-mini"
    HAIKU_BASE_URL="https://api.your-provider.com/v1"
    HAIKU_API_KEY="sk-your-secret-key"
    ```
2.  **啟動本地伺服器**:
    ```bash
    npx wrangler dev
    ```
    這將在本地 `http://localhost:8787` 啟動一個開發伺服器。
