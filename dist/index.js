"use strict";
/**
 * Claude-to-OpenAI API Proxy for Node.js
 *
 * This Express server acts as a proxy, converting API requests from the Claude format to the OpenAI format,
 * and then converting the responses back. It enables using OpenAI-compatible APIs (like OpenAI,
 * Azure OpenAI, Google Gemini, Ollama, etc.) with clients designed for the Claude API.
 *
 * Features:
 * - Full support for the /v1/messages endpoint.
 * - Correctly handles and translates tool calls (function calling), including cleaning schemas
 * for compatibility with strict APIs like Google Gemini.
 * - Supports streaming responses (Server-Sent Events).
 * - Designed for easy deployment on any Node.js hosting platform.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertImageBlockToOpenAI = convertImageBlockToOpenAI;
exports.convertClaudeToOpenAIRequest = convertClaudeToOpenAIRequest;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
// import { appendFile } from 'fs/promises';
// import { join } from 'path';
// 加载环境变量
dotenv_1.default.config();
// --- Express App Setup ---
const app = (0, express_1.default)();
const PORT = process.env.PORT || 8092;
const DEBUG_STOP_REASON = process.env.DEBUG_STOP_REASON === '1';
const DEBUG_UPSTREAM_IO = process.env.DEBUG_UPSTREAM_IO === '1';
function sanitizeHeadersForLog(headers) {
    const sanitized = { ...headers };
    if (sanitized.Authorization) {
        sanitized.Authorization = 'Bearer ***';
    }
    if (sanitized.authorization) {
        sanitized.authorization = 'Bearer ***';
    }
    return sanitized;
}
function stringifyForDebug(value) {
    try {
        return JSON.stringify(value, null, 2);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return `{"_debug_error":"failed_to_stringify","message":"${errorMessage}"}`;
    }
}
// 中间件
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '100mb' }));
// 获取环境变量
const env = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'http://localhost:8094/v1',
    PORT: process.env.PORT || '8092',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
};
// --- Main Route Handler ---
app.all('/v1/messages', async (req, res) => {
    if (req.method === "OPTIONS") {
        return handleOptions(res);
    }
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed" });
    }
    const authHeader = (req.headers['authorization'] || req.headers['Authorization']);
    const bearerMatch = authHeader && authHeader.match(/^Bearer\s+(.+)$/i);
    const apiKey = (bearerMatch && bearerMatch[1]) || req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ error: 'Missing API key. Provide Authorization: Bearer <key> or x-api-key header.' });
    }
    try {
        const claudeRequest = req.body;
        // --- Configuration Selection ---
        let targetApiKey = apiKey;
        let targetModelName;
        let targetBaseUrl;
        // 设成本地chat的完整base_url，如http://localhost:8094/v1
        targetBaseUrl = env.OPENAI_BASE_URL;
        targetModelName = claudeRequest.model;
        const target = {
            modelName: targetModelName,
            baseUrl: targetBaseUrl,
            apiKey: targetApiKey,
        };
        const openaiRequest = convertClaudeToOpenAIRequest(claudeRequest, target.modelName);
        // console.log(`openaiRequest: ${JSON.stringify(openaiRequest)}`);
        // console.log(`target.baseUrl: ${target.baseUrl}`);
        // console.log(`target.apiKey: ${target.apiKey}`);
        // 组装上游请求 headers，透传 User-Agent/Referer，并将真实 IP 追加到 User-Agent 做记录
        const upstreamHeaders = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${target.apiKey}`,
            "X-Qiniu-Source": "anthropic",
        };
        let realIp;
        const realIpHeader = req.headers['x-real-ip'];
        if (realIpHeader) {
            realIp = Array.isArray(realIpHeader) ? realIpHeader[0]?.trim() : realIpHeader?.trim();
        }
        if (!realIp) {
            const forwardedFor = req.headers['x-forwarded-for'];
            const forwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
            if (forwarded)
                realIp = forwarded.split(',')[0].trim();
        }
        if (!realIp && req.socket?.remoteAddress)
            realIp = req.socket.remoteAddress;
        if (!realIp && req.ip)
            realIp = req.ip;
        if (realIp) {
            upstreamHeaders['X-Real-IP'] = realIp;
        }
        const userAgentHeader = req.headers['user-agent'];
        const baseUserAgent = userAgentHeader ? (Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader) : '';
        upstreamHeaders['User-Agent'] = realIp ? `${baseUserAgent} [X-Real-IP: ${realIp}]`.trim() : (baseUserAgent || '');
        const refererHeader = req.headers['referer'];
        if (refererHeader) {
            upstreamHeaders['Referer'] = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
        }
        // 透传用户请求的其他 header 到上游（不覆盖已设置的）
        const skipKeys = new Set(['host', 'content-length', 'content-type', 'authorization', 'connection']);
        const passthroughPrefixes = ['x-'];
        const passthroughNames = ['accept', 'accept-language', 'accept-encoding'];
        for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined)
                continue;
            const lower = key.toLowerCase();
            if (skipKeys.has(lower))
                continue;
            if (upstreamHeaders[lower] !== undefined)
                continue;
            const valueStr = Array.isArray(value) ? value[0] : value;
            if (passthroughNames.includes(lower) || passthroughPrefixes.some(p => lower.startsWith(p))) {
                upstreamHeaders[key] = valueStr;
            }
        }
        if (DEBUG_UPSTREAM_IO) {
            const debugRequestLog = {
                url: `${target.baseUrl}/chat/completions`,
                method: 'POST',
                headers: sanitizeHeadersForLog(upstreamHeaders),
                body: openaiRequest,
            };
            console.log(`[upstream][request] ${stringifyForDebug(debugRequestLog)}`);
        }
        // 临时调试：打印发往上游的请求 body 和 headers（注意包含完整对话内容）
        // 已暂时关闭，如需再次启用，取消以下代码注释即可
        // const debugLogPath = join(process.cwd(), 'debug_upstream_request.jsonl');
        // const logEntry = {
        //     timestamp: new Date().toISOString(),
        //     upstreamHeaders,
        //     request: openaiRequest
        // };
        // appendFile(debugLogPath, JSON.stringify(logEntry) + '\n').catch(err => {
        //     console.error('[DEBUG] Failed to write debug log:', err);
        // });
        const openaiApiResponse = await fetch(`${target.baseUrl}/chat/completions`, {
            method: "POST",
            headers: upstreamHeaders,
            body: JSON.stringify(openaiRequest),
        });
        if (!openaiApiResponse.ok) {
            const errorBody = await openaiApiResponse.text();
            return res.status(openaiApiResponse.status).json(JSON.parse(errorBody));
        }
        // 透传 http_x_reqid header
        const reqIdHeader = openaiApiResponse.headers.get('http_x_reqid');
        if (reqIdHeader) {
            res.setHeader('http_x_reqid', reqIdHeader);
        }
        if (claudeRequest.stream) {
            const transformStream = new TransformStream({
                transform: streamTransformer(claudeRequest.model, DEBUG_UPSTREAM_IO),
            });
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Connection', 'keep-alive');
            // 将 OpenAI 响应流通过转换流传递给客户端
            if (openaiApiResponse.body) {
                openaiApiResponse.body.pipeThrough(transformStream).pipeTo(new WritableStream({
                    write(chunk) {
                        res.write(chunk);
                    },
                    close() {
                        res.end();
                    }
                })).catch((err) => {
                    // 上游连接中断（如 BodyTimeoutError）时，pipeTo 的 Promise 会 reject。
                    // 若不捕获，会变成 unhandledRejection 导致 Node.js 进程崩溃。
                    console.error('[stream] upstream pipe error:', err?.message || err);
                    if (!res.writableEnded) {
                        res.end();
                    }
                });
            }
        }
        else {
            const openaiResponse = await openaiApiResponse.json();
            if (DEBUG_UPSTREAM_IO) {
                console.log(`[upstream][response][non-stream] ${stringifyForDebug(openaiResponse)}`);
            }
            const claudeResponse = convertOpenAIToClaudeResponse(openaiResponse, claudeRequest.model);
            return res.json(claudeResponse);
        }
    }
    catch (e) {
        console.error('Error processing request:', e);
        return res.status(500).json({ error: e.message });
    }
});
// 健康检查端点
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// 全局兜底：捕获所有未处理的 Promise rejection，防止进程崩溃
process.on('unhandledRejection', (reason, promise) => {
    console.error('[unhandledRejection] Unhandled promise rejection:', reason?.message || reason);
    // 仅记录日志，不退出进程，保持服务可用
});
// 启动服务器
app.listen(PORT, () => {
    console.log(`Claude Proxy server is running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`API endpoint: http://localhost:${PORT}/v1/messages`);
});
// ======================= Helper Functions =======================
/**
 * Recursively cleans a JSON Schema to make it compatible with target APIs like Google Gemini.
 * - Removes '$schema' and 'additionalProperties' keys.
 * - For properties of type 'string', removes the 'format' field unless it's 'date-time' or 'enum'.
 * @param schema The schema object to clean.
 */
function recursivelyCleanSchema(schema) {
    if (schema === null || typeof schema !== 'object') {
        return schema;
    }
    if (Array.isArray(schema)) {
        return schema.map(item => recursivelyCleanSchema(item));
    }
    const newSchema = {};
    for (const key in schema) {
        if (Object.prototype.hasOwnProperty.call(schema, key)) {
            if (key === '$schema' || key === 'additionalProperties') {
                continue;
            }
            newSchema[key] = recursivelyCleanSchema(schema[key]);
        }
    }
    if (newSchema.type === 'string' && newSchema.format) {
        const supportedFormats = ['date-time', 'enum'];
        if (!supportedFormats.includes(newSchema.format)) {
            delete newSchema.format;
        }
    }
    return newSchema;
}
/**
 * 将 Claude 图片块转换为 OpenAI image_url 格式
 */
function convertImageBlockToOpenAI(block) {
    let imageUrl;
    if (block.source.type === 'url') {
        imageUrl = block.source.url;
    }
    else {
        const src = block.source;
        imageUrl = `data:${src.media_type};base64,${src.data}`;
    }
    const base = {
        type: 'image_url',
        image_url: { url: imageUrl },
    };
    if (block.cache_control !== undefined) {
        base.cache_control = block.cache_control;
    }
    return base;
}
function extractCacheCreationTokens(details) {
    if (!details || typeof details !== 'object')
        return 0;
    if (typeof details.cache_creation_input_tokens === 'number') {
        return details.cache_creation_input_tokens;
    }
    // Backward compatibility: some upstreams still use cache_creation_tokens.
    if (typeof details.cache_creation_tokens === 'number') {
        return details.cache_creation_tokens;
    }
    if (details.cache_creation && typeof details.cache_creation === 'object') {
        // Qwen may only provide per-cache-type token counts in cache_creation.
        return Object.values(details.cache_creation).reduce((sum, value) => {
            return typeof value === 'number' ? sum + value : sum;
        }, 0);
    }
    return 0;
}
function extractPromptCacheDetails(promptTokensDetails) {
    if (!promptTokensDetails || typeof promptTokensDetails !== 'object') {
        return { cacheReadTokens: 0, cacheCreationTokens: 0 };
    }
    const cacheReadTokens = typeof promptTokensDetails.cached_tokens === 'number' ? promptTokensDetails.cached_tokens : 0;
    const cacheCreationTokens = extractCacheCreationTokens(promptTokensDetails);
    const cacheCreation = (promptTokensDetails.cache_creation && typeof promptTokensDetails.cache_creation === 'object')
        ? promptTokensDetails.cache_creation
        : undefined;
    const cacheType = (typeof promptTokensDetails.cache_type === 'string' && promptTokensDetails.cache_type)
        ? promptTokensDetails.cache_type
        : undefined;
    return { cacheReadTokens, cacheCreationTokens, cacheCreation, cacheType };
}
function buildAnthropicCacheCreation(cacheCreation) {
    return {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
        ...(cacheCreation && typeof cacheCreation === 'object' ? cacheCreation : {}),
    };
}
function buildOutputTokensDetails(completionTokensDetails) {
    if (!completionTokensDetails || typeof completionTokensDetails !== 'object') {
        return undefined;
    }
    const reasoningTokens = completionTokensDetails.reasoning_tokens;
    if (typeof reasoningTokens !== 'number') {
        return undefined;
    }
    return { thinking_tokens: reasoningTokens };
}
function applyOutputTokensDetails(usage, completionTokensDetails) {
    const outputTokensDetails = buildOutputTokensDetails(completionTokensDetails);
    if (outputTokensDetails !== undefined) {
        usage.output_tokens_details = outputTokensDetails;
    }
}
/**
 * Converts a Claude API request to the OpenAI format.
 */
function convertClaudeToOpenAIRequest(claudeRequest, modelName) {
    const openaiMessages = [];
    if (claudeRequest.system) {
        openaiMessages.push({ role: "system", content: claudeRequest.system });
    }
    for (let i = 0; i < claudeRequest.messages.length; i++) {
        const message = claudeRequest.messages[i];
        if (message.role === 'user') {
            if (Array.isArray(message.content)) {
                const toolResults = message.content.filter(c => c.type === 'tool_result');
                const otherContent = message.content.filter(c => c.type !== 'tool_result');
                if (toolResults.length > 0) {
                    toolResults.forEach(block => {
                        let toolContentStr;
                        const imageContentBlocks = [];
                        if (typeof block.content === 'string') {
                            // 简单字符串内容，直接使用
                            toolContentStr = block.content;
                        }
                        else if (Array.isArray(block.content)) {
                            // 数组内容：分离图片块和非图片块
                            const nonImageParts = [];
                            for (const item of block.content) {
                                if (item.type === 'image' && item.source) {
                                    // 图片块：转换为 OpenAI image_url 格式，稍后放入 user 消息
                                    imageContentBlocks.push(convertImageBlockToOpenAI(item));
                                }
                                else {
                                    nonImageParts.push(item);
                                }
                            }
                            // 非图片部分：如果只有一个文本块，提取其 text；否则 JSON.stringify
                            if (nonImageParts.length === 1 && nonImageParts[0].type === 'text' && nonImageParts[0].text) {
                                toolContentStr = nonImageParts[0].text;
                            }
                            else if (nonImageParts.length > 0) {
                                toolContentStr = JSON.stringify(nonImageParts);
                            }
                            else {
                                // 内容全是图片，tool 消息放一个占位文本
                                toolContentStr = '[image]';
                            }
                        }
                        else {
                            toolContentStr = JSON.stringify(block.content);
                        }
                        const toolMessage = {
                            role: 'tool',
                            tool_call_id: block.tool_use_id,
                            content: toolContentStr,
                        };
                        // 透传 tool_result block 上的 cache_control
                        if (block.cache_control !== undefined) {
                            toolMessage.cache_control = block.cache_control;
                        }
                        openaiMessages.push(toolMessage);
                        // 如果有图片块，创建一个紧跟在 tool 消息后面的 user 消息
                        if (imageContentBlocks.length > 0) {
                            openaiMessages.push({
                                role: 'user',
                                content: imageContentBlocks,
                            });
                        }
                    });
                }
                if (otherContent.length > 0) {
                    const mappedContent = otherContent.map((block) => {
                        // 文本块：透传 cache_control 等附加字段
                        if (block.type === 'text') {
                            const base = {
                                type: 'text',
                                text: block.text,
                            };
                            if (block.cache_control !== undefined) {
                                base.cache_control = block.cache_control;
                            }
                            return base;
                        }
                        // 图片块：支持 base64 和 url 两种来源，透传 cache_control
                        if (block.type === 'image' && block.source) {
                            return convertImageBlockToOpenAI(block);
                        }
                        // 文档块：将 Claude document 格式转换为 OpenAI file 格式
                        // base64 来源使用 file_data，URL 来源使用 file_id
                        if (block.type === 'document' && block.source) {
                            let file;
                            if (block.source.type === 'url') {
                                file = { file_id: block.source.url };
                            }
                            else {
                                // base64 来源：构造 data URL 放入 file_data
                                const src = block.source;
                                file = { file_data: `data:${src.media_type};base64,${src.data}` };
                            }
                            const base = {
                                type: 'file',
                                file,
                            };
                            if (block.cache_control !== undefined) {
                                base.cache_control = block.cache_control;
                            }
                            return base;
                        }
                        // 其他类型（如 thinking/tool_use 等）目前按原样透传，防止误删字段
                        return block;
                    });
                    openaiMessages.push({
                        role: "user",
                        content: mappedContent,
                    });
                }
            }
            else {
                openaiMessages.push({ role: "user", content: message.content });
            }
        }
        else if (message.role === 'assistant') {
            // assistant 消息既可能是字符串（旧格式），也可能是 content block 数组（推荐格式）
            // 如果是字符串，直接按文本透传，避免被误处理成空字符串
            if (!Array.isArray(message.content)) {
                openaiMessages.push({
                    role: 'assistant',
                    content: message.content || '',
                });
                continue;
            }
            const contentBlocks = [];
            const toolCalls = [];
            if (Array.isArray(message.content)) {
                message.content.forEach(block => {
                    if (block.type === 'text') {
                        const textBlock = {
                            type: 'text',
                            text: block.text || '',
                        };
                        if (block.cache_control !== undefined) {
                            textBlock.cache_control = block.cache_control;
                        }
                        contentBlocks.push(textBlock);
                    }
                    else if (block.type === 'thinking') {
                        // Preserve thinking blocks in OpenAI format with signature，并透传 cache_control
                        const thinkingBlock = {
                            type: 'thinking',
                            thinking: block.thinking || block.text || ''
                        };
                        if (block.signature) {
                            thinkingBlock.signature = block.signature;
                        }
                        if (block.cache_control !== undefined) {
                            thinkingBlock.cache_control = block.cache_control;
                        }
                        contentBlocks.push(thinkingBlock);
                    }
                    else if (block.type === 'tool_use') {
                        const toolCall = {
                            id: block.id,
                            type: 'function',
                            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
                        };
                        // 透传 tool_use block 上的 cache_control
                        if (block.cache_control !== undefined) {
                            toolCall.cache_control = block.cache_control;
                        }
                        toolCalls.push(toolCall);
                    }
                });
            }
            // If we have structured content blocks (thinking or multiple text blocks), use array format
            // Otherwise, use simple string format for backward compatibility
            let content;
            if (contentBlocks.length === 0) {
                content = '';
            }
            else if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') {
                content = contentBlocks[0].text || '';
            }
            else {
                content = contentBlocks;
            }
            const assistantMessage = { role: 'assistant', content };
            if (toolCalls.length > 0) {
                assistantMessage.tool_calls = toolCalls;
            }
            openaiMessages.push(assistantMessage);
        }
    }
    const openaiRequest = {
        model: modelName,
        messages: openaiMessages,
        max_tokens: claudeRequest.max_tokens,
        temperature: claudeRequest.temperature,
        top_p: claudeRequest.top_p,
        stream: claudeRequest.stream,
        stop: claudeRequest.stop_sequences,
    };
    // Pass through thinking parameter if present
    if (claudeRequest.thinking) {
        openaiRequest.thinking = claudeRequest.thinking;
    }
    // 将 Claude output_config.format 转换为 OpenAI response_format
    if (claudeRequest.output_config?.format) {
        const format = claudeRequest.output_config.format;
        if (format.type === 'json_schema' && format.schema) {
            openaiRequest.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: 'json_output', // Claude 没有 name 字段，OpenAI 要求必填，使用默认值
                    schema: format.schema, // 直接透传 schema，不做清理（strict 模式需要 additionalProperties）
                    strict: true,
                },
            };
        }
    }
    // 透传 Claude output_config.effort 到上游（用于推理强度控制）
    if (claudeRequest.output_config?.effort) {
        openaiRequest.output_config = {
            ...(openaiRequest.output_config || {}),
            effort: claudeRequest.output_config.effort,
        };
    }
    if (claudeRequest.tools) {
        openaiRequest.tools = claudeRequest.tools.map((tool) => {
            const cleanedParameters = recursivelyCleanSchema(tool.input_schema);
            return {
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: cleanedParameters,
                },
            };
        });
    }
    if (claudeRequest.tool_choice) {
        if (claudeRequest.tool_choice.type === 'auto') {
            openaiRequest.tool_choice = 'auto';
        }
        else if (claudeRequest.tool_choice.type === 'any') {
            openaiRequest.tool_choice = 'required';
        }
        else if (claudeRequest.tool_choice.type === 'none') {
            openaiRequest.tool_choice = 'none';
        }
        else if (claudeRequest.tool_choice.type === 'tool') {
            openaiRequest.tool_choice = { type: 'function', function: { name: claudeRequest.tool_choice.name } };
        }
    }
    // Ensure usage is included in streaming responses when supported by the upstream API
    if (claudeRequest.stream) {
        openaiRequest.stream_options = { include_usage: true };
    }
    return openaiRequest;
}
/**
 * Converts a non-streaming OpenAI response to the Claude format.
 */
function convertOpenAIToClaudeResponse(openaiResponse, model) {
    const mapOpenAIIdToClaude = (openaiId) => {
        if (!openaiId || typeof openaiId !== 'string')
            return `msg_${Math.random().toString(36).substr(2, 9)}`;
        const match = openaiId.match(/^[a-zA-Z]+-([A-Za-z0-9_\-]+)/);
        const suffix = match ? match[1] : openaiId;
        return `msg_${suffix}`;
    };
    // 提取 id 的后缀部分（去掉前缀），用于签名
    const extractIdSuffix = (id) => {
        if (!id || typeof id !== 'string')
            return '';
        const match = id.match(/^[a-zA-Z]+-([A-Za-z0-9_\-]+)/);
        return match ? match[1] : id;
    };
    const choice = openaiResponse.choices[0];
    const contentBlocks = [];
    const messageId = mapOpenAIIdToClaude(openaiResponse.id);
    const originalId = openaiResponse.id; // 原始的 OpenAI id，用于签名
    // Handle thinking blocks first (they should appear before text content in Claude format)
    // 如果 thinking_blocks 存在，优先使用 thinking_blocks
    if (choice.message.thinking_blocks && choice.message.thinking_blocks.length > 0) {
        choice.message.thinking_blocks.forEach((block) => {
            const thinkingBlock = {
                type: 'thinking',
                thinking: block.thinking,
            };
            // thinking_blocks 存在时，使用 block 的 signature 或原始 id
            if (block.signature) {
                thinkingBlock.signature = block.signature;
            }
            contentBlocks.push(thinkingBlock);
        });
    }
    else if (choice.message.reasoning_content) {
        // thinking_blocks 不存在时，使用 reasoning_content，签名使用 id 后缀（去掉前缀）
        const thinkingBlock = {
            type: 'thinking',
            thinking: choice.message.reasoning_content,
            signature: extractIdSuffix(originalId), // 签名使用 id 后缀（去掉前缀）
        };
        contentBlocks.push(thinkingBlock);
    }
    if (choice.message.content) {
        contentBlocks.push({ type: 'text', text: choice.message.content });
    }
    if (choice.message.tool_calls) {
        choice.message.tool_calls.forEach((call) => {
            contentBlocks.push({
                type: 'tool_use',
                id: call.id,
                name: call.function.name,
                input: JSON.parse(call.function.arguments),
            });
        });
    }
    const stopReasonMap = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
    console.log(`messageId: ${messageId}`);
    // Build usage object with cache details if available
    // Anthropic: total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
    // OpenAI prompt_tokens = total, so input_tokens = prompt_tokens - cached - cache_creation
    const inputTokens = openaiResponse.usage.prompt_tokens;
    const { cacheReadTokens, cacheCreationTokens, cacheCreation, cacheType, } = extractPromptCacheDetails(openaiResponse.usage.prompt_tokens_details);
    const usage = {
        input_tokens: Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens),
        output_tokens: openaiResponse.usage.completion_tokens,
        cache_read_input_tokens: cacheReadTokens,
        cache_creation_input_tokens: cacheCreationTokens,
        cache_creation: buildAnthropicCacheCreation(cacheCreation),
    };
    // cache_type absent => do not output.
    if (cacheType !== undefined) {
        usage.cache_type = cacheType;
    }
    applyOutputTokensDetails(usage, openaiResponse.usage.completion_tokens_details);
    return {
        id: messageId,
        type: "message",
        role: "assistant",
        model: model,
        content: contentBlocks,
        stop_reason: stopReasonMap[choice.finish_reason] || "end_turn",
        usage: usage,
    };
}
/**
 * Creates a transform function for the streaming response.
 * Handles OpenAI streaming format including thinking_blocks and converts to Claude SSE format.
 */
function streamTransformer(model, debugUpstreamIo = false) {
    const mapOpenAIIdToClaude = (openaiId) => {
        if (!openaiId || typeof openaiId !== 'string')
            return `msg_${Math.random().toString(36).substr(2, 9)}`;
        const match = openaiId.match(/^[a-zA-Z]+-([A-Za-z0-9_\-]+)/);
        const suffix = match ? match[1] : openaiId;
        return `msg_${suffix}`;
    };
    // 提取 id 的后缀部分（去掉前缀），用于 reasoning_content 的签名
    const extractIdSuffix = (id) => {
        if (!id || typeof id !== 'string')
            return '';
        const match = id.match(/^[a-zA-Z]+-([A-Za-z0-9_\-]+)/);
        return match ? match[1] : id;
    };
    let initialized = false;
    let buffer = "";
    let messageId = null;
    let requestId = null; // Store original OpenAI request id for signature
    const toolCalls = {};
    const thinkingBlocks = {};
    let contentBlockIndex = -1; // Start at -1, will be incremented to 0 for first block
    let textBlockStarted = false; // Track if text block has been started
    let textContent = '';
    let reasoningBlockStarted = false; // Track if reasoning_content block has been started
    let reasoningContent = ''; // Track reasoning_content content
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let cacheCreation = undefined;
    let cacheType = undefined;
    let lastCompletionTokensDetails = undefined;
    let lastDelta = null; // Track last delta to detect transitions
    let lastFinishReasonFromChunks = null;
    const sendEvent = (controller, event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };
    return (chunk, controller) => {
        const stopThinkingBlock = (thinkingIndex) => {
            const tb = thinkingBlocks[thinkingIndex];
            if (tb && tb.started && !tb.stopped) {
                sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: tb.claudeIndex });
                tb.stopped = true;
            }
        };
        const stopTextBlock = () => {
            if (textBlockStarted) {
                sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: contentBlockIndex });
                textBlockStarted = false;
            }
        };
        const stopToolBlock = (toolIndex) => {
            const tc = toolCalls[toolIndex];
            if (tc && tc.started && !tc.stopped) {
                sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: tc.claudeIndex });
                tc.stopped = true;
            }
        };
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        // removed per-chunk reinitialization of inputTokens/outputTokens to preserve totals across chunks
        for (const line of lines) {
            if (!line.startsWith("data: "))
                continue;
            if (debugUpstreamIo) {
                console.log(`[upstream][response][stream-line] ${line}`);
            }
            const data = line.substring(6);
            if (data.trim() === "[DONE]") {
                // Stop all active content blocks
                // Stop reasoning block if it's still active
                if (reasoningBlockStarted) {
                    // reasoning_content 的签名使用 id 后缀（去掉前缀）
                    const signatureValue = extractIdSuffix(requestId || messageId);
                    sendEvent(controller, 'content_block_delta', {
                        type: 'content_block_delta',
                        index: contentBlockIndex,
                        delta: { type: 'signature_delta', signature: signatureValue }
                    });
                    sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: contentBlockIndex });
                    reasoningBlockStarted = false;
                }
                Object.keys(thinkingBlocks).forEach(key => stopThinkingBlock(Number(key)));
                stopTextBlock();
                Object.keys(toolCalls).forEach(key => stopToolBlock(Number(key)));
                let finalStopReason = "end_turn";
                try {
                    if (DEBUG_STOP_REASON) {
                        console.log(`[stop_reason][DONE] messageId=${messageId} lines_count=${lines.length} tail=${JSON.stringify(lines.slice(-3))} last_finish_reason_seen=${lastFinishReasonFromChunks}`);
                    }
                    // Prefer finish_reason captured from normal chunk parsing.
                    // Fallback to historical line-based parsing only when missing.
                    let finishReason = lastFinishReasonFromChunks;
                    if (!finishReason) {
                        const lastChunk = JSON.parse(lines[lines.length - 2].substring(6));
                        finishReason = lastChunk.choices[0].finish_reason;
                    }
                    if (finishReason === 'tool_calls')
                        finalStopReason = 'tool_use';
                    if (finishReason === 'length')
                        finalStopReason = 'max_tokens';
                    if (DEBUG_STOP_REASON) {
                        console.log(`[stop_reason][DONE] parsed_finish_reason=${finishReason} final_stop_reason=${finalStopReason} messageId=${messageId}`);
                    }
                }
                catch (error) {
                    if (DEBUG_STOP_REASON) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        console.log(`[stop_reason][DONE] parse_failed messageId=${messageId} error=${errorMessage} fallback_final_stop_reason=${finalStopReason} last_finish_reason_seen=${lastFinishReasonFromChunks}`);
                    }
                }
                // 构建完整的 Claude 响应内容
                const claudeContent = [];
                // Add reasoning_content as thinking block if present
                if (reasoningContent) {
                    const reasoningBlock = { type: 'thinking', thinking: reasoningContent };
                    // reasoning_content 的签名使用 id 后缀（去掉前缀）
                    const signatureValue = extractIdSuffix(requestId || messageId);
                    if (signatureValue) {
                        reasoningBlock.signature = signatureValue;
                    }
                    claudeContent.push(reasoningBlock);
                }
                Object.values(thinkingBlocks).forEach(tb => {
                    if (tb.started && tb.content) {
                        const block = { type: 'thinking', thinking: tb.content };
                        if (tb.signature)
                            block.signature = tb.signature;
                        claudeContent.push(block);
                    }
                });
                if (textContent) {
                    claudeContent.push({ type: 'text', text: textContent });
                }
                Object.values(toolCalls).forEach(tc => {
                    if (tc.started) {
                        let input_tmp;
                        try {
                            input_tmp = JSON.parse(tc.args || '{}');
                        }
                        catch {
                            input_tmp = { input_str: tc.args || '' };
                            console.log(`[tool_use] Invalid JSON in args, fallback to input_str. messageId=${messageId}, name=${tc.name}, args=${tc.args}`);
                        }
                        claudeContent.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.name,
                            input: input_tmp
                        });
                    }
                });
                // Build usage object with cache details
                // Anthropic: total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
                // OpenAI prompt_tokens = total, so input_tokens = prompt_tokens - cached - cache_creation
                const usageData = {
                    input_tokens: Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens),
                    output_tokens: outputTokens,
                    cache_read_input_tokens: cacheReadTokens,
                    cache_creation_input_tokens: cacheCreationTokens,
                    cache_creation: buildAnthropicCacheCreation(cacheCreation),
                };
                if (cacheType !== undefined) {
                    usageData.cache_type = cacheType;
                }
                applyOutputTokensDetails(usageData, lastCompletionTokensDetails);
                sendEvent(controller, 'message_delta', { type: 'message_delta', delta: { stop_reason: finalStopReason, stop_sequence: null }, usage: usageData });
                sendEvent(controller, 'message_stop', { type: 'message_stop' });
                controller.terminate();
                return;
            }
            try {
                const openaiChunk = JSON.parse(data);
                const chunkFinishReason = openaiChunk?.choices?.[0]?.finish_reason;
                if (typeof chunkFinishReason === 'string') {
                    lastFinishReasonFromChunks = chunkFinishReason;
                    if (DEBUG_STOP_REASON) {
                        console.log(`[stop_reason][chunk] messageId=${messageId} finish_reason=${chunkFinishReason}`);
                    }
                }
                const delta = openaiChunk.choices[0]?.delta;
                // 第一次解析：获取 id 或备用占位 id，并发送 message_start
                if (!initialized) {
                    if (openaiChunk.id) {
                        requestId = openaiChunk.id; // Store original id for signature
                        messageId = mapOpenAIIdToClaude(openaiChunk.id);
                    }
                    else {
                        messageId = `msg_${Math.random().toString(36).substr(2, 9)}`;
                    }
                    console.log(`messageId: ${messageId}`);
                    sendEvent(controller, 'message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
                    initialized = true;
                }
                if (openaiChunk.usage) {
                    const { prompt_tokens, completion_tokens, prompt_tokens_details, completion_tokens_details } = openaiChunk.usage;
                    if (typeof prompt_tokens === 'number') {
                        inputTokens = Math.max(inputTokens, prompt_tokens);
                    }
                    if (typeof completion_tokens === 'number') {
                        outputTokens = Math.max(outputTokens, completion_tokens);
                    }
                    if (completion_tokens_details) {
                        lastCompletionTokensDetails = completion_tokens_details;
                    }
                    // Handle cache-related token details
                    if (prompt_tokens_details) {
                        const details = extractPromptCacheDetails(prompt_tokens_details);
                        cacheReadTokens = Math.max(cacheReadTokens, details.cacheReadTokens);
                        cacheCreationTokens = Math.max(cacheCreationTokens, details.cacheCreationTokens);
                        if (details.cacheCreation !== undefined) {
                            cacheCreation = details.cacheCreation;
                        }
                        // cache_type absent => do not output.
                        if (details.cacheType !== undefined) {
                            cacheType = details.cacheType;
                        }
                    }
                    // Log each time usage appears in the stream
                    // console.log('[stream usage]', { prompt_tokens, completion_tokens, inputTokens, outputTokens });
                }
                if (!delta)
                    continue;
                // Detect transitions between different content types
                // If we're switching from thinking to text/tool_calls, stop thinking block
                // 合并条件，避免重复调用 stopThinkingBlock
                // 只处理已启动且未停止的 thinking block
                if (lastDelta?.thinking_blocks && !delta.thinking_blocks && (delta.content || delta.tool_calls)) {
                    Object.keys(thinkingBlocks).forEach(key => {
                        const tb = thinkingBlocks[Number(key)];
                        if (tb && tb.started && !tb.stopped) {
                            stopThinkingBlock(Number(key));
                        }
                    });
                }
                // If we're switching from text to tool calls, stop text block
                if (lastDelta?.content && delta.tool_calls && !delta.content) {
                    stopTextBlock();
                }
                // If we're switching from reasoning_content to thinking_blocks, stop reasoning_content block
                // thinking_blocks 优先级高于 reasoning_content
                if (lastDelta?.reasoning_content !== undefined && !delta.reasoning_content && delta.thinking_blocks && reasoningBlockStarted) {
                    // reasoning_content 的签名使用 id 后缀（去掉前缀）
                    const signatureValue = extractIdSuffix(requestId || messageId);
                    sendEvent(controller, 'content_block_delta', {
                        type: 'content_block_delta',
                        index: contentBlockIndex,
                        delta: { type: 'signature_delta', signature: signatureValue }
                    });
                    sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: contentBlockIndex });
                    reasoningBlockStarted = false;
                }
                // Handle reasoning_content transition - output signature when transitioning away from reasoning_content
                // 只有当 thinking_blocks 不存在时才处理 reasoning_content
                if (lastDelta?.reasoning_content !== undefined && delta.reasoning_content === undefined && reasoningBlockStarted && !delta.thinking_blocks) {
                    // reasoning_content has ended, output signature and stop the reasoning block
                    // reasoning_content 的签名使用 id 后缀（去掉前缀）
                    const signatureValue = extractIdSuffix(requestId || messageId);
                    sendEvent(controller, 'content_block_delta', {
                        type: 'content_block_delta',
                        index: contentBlockIndex,
                        delta: { type: 'signature_delta', signature: signatureValue }
                    });
                    // Stop the reasoning block
                    sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: contentBlockIndex });
                    reasoningBlockStarted = false;
                    // 每结束一个块就递增 index
                    contentBlockIndex++;
                }
                lastDelta = delta;
                // Handle thinking blocks first (they should come before text)
                // thinking_blocks 优先级高于 reasoning_content
                if (delta.thinking_blocks && delta.thinking_blocks.length > 0) {
                    for (const thinking_delta of delta.thinking_blocks) {
                        const thinkingIndex = 0; // Usually there's only one thinking block
                        if (!thinkingBlocks[thinkingIndex]) {
                            thinkingBlocks[thinkingIndex] = { content: '', claudeIndex: 0, started: false, stopped: false };
                        }
                        // Store signature if present
                        if (thinking_delta.signature) {
                            thinkingBlocks[thinkingIndex].signature = thinking_delta.signature;
                        }
                        // Start thinking block if we have thinking content OR if we just received a signature for an already-started block
                        if (thinking_delta.thinking || (thinking_delta.signature && thinkingBlocks[thinkingIndex].started)) {
                            if (!thinkingBlocks[thinkingIndex].started) {
                                // 如果是第一个 block，从 -1 递增到 0；否则递增 contentBlockIndex
                                if (contentBlockIndex === -1) {
                                    contentBlockIndex = 0;
                                }
                                else {
                                    contentBlockIndex++;
                                }
                                thinkingBlocks[thinkingIndex].claudeIndex = contentBlockIndex;
                                thinkingBlocks[thinkingIndex].started = true;
                                thinkingBlocks[thinkingIndex].stopped = false;
                                // Include signature in content_block_start if available
                                const contentBlock = { type: 'thinking', thinking: '' };
                                if (thinkingBlocks[thinkingIndex].signature) {
                                    contentBlock.signature = thinkingBlocks[thinkingIndex].signature;
                                }
                                sendEvent(controller, 'content_block_start', { type: 'content_block_start', index: contentBlockIndex, content_block: contentBlock });
                            }
                            // Only send thinking_delta if there's actual content
                            if (thinking_delta.thinking) {
                                thinkingBlocks[thinkingIndex].content += thinking_delta.thinking;
                                sendEvent(controller, 'content_block_delta', { type: 'content_block_delta', index: thinkingBlocks[thinkingIndex].claudeIndex, delta: { type: 'thinking_delta', thinking: thinking_delta.thinking } });
                            }
                            // If we just received the signature for an already-started block, send a signature_delta
                            if (thinking_delta.signature && thinkingBlocks[thinkingIndex].started) {
                                sendEvent(controller, 'content_block_delta', { type: 'content_block_delta', index: thinkingBlocks[thinkingIndex].claudeIndex, delta: { type: 'signature_delta', signature: thinking_delta.signature } });
                            }
                        }
                    }
                }
                // Handle reasoning_content (convert to thinking)
                // 只有当 thinking_blocks 不存在时才处理 reasoning_content
                if (delta.reasoning_content && !delta.thinking_blocks) {
                    if (!reasoningBlockStarted) {
                        // Start a new thinking block for reasoning_content
                        // 如果是第一个 block，从 -1 递增到 0；否则递增 contentBlockIndex
                        if (contentBlockIndex === -1) {
                            contentBlockIndex = 0;
                        }
                        else {
                            contentBlockIndex++;
                        }
                        reasoningBlockStarted = true;
                        sendEvent(controller, 'content_block_start', {
                            type: 'content_block_start',
                            index: contentBlockIndex,
                            content_block: { type: 'thinking', thinking: '' }
                        });
                    }
                    reasoningContent += delta.reasoning_content;
                    sendEvent(controller, 'content_block_delta', {
                        type: 'content_block_delta',
                        index: contentBlockIndex,
                        delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
                    });
                }
                // Handle text content
                if (delta.content) {
                    if (!textBlockStarted) {
                        // 如果是第一个 block，从 -1 递增到 0；否则递增 contentBlockIndex
                        if (contentBlockIndex === -1) {
                            contentBlockIndex = 0;
                        }
                        else {
                            contentBlockIndex++;
                        }
                        sendEvent(controller, 'content_block_start', { type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'text', text: '' } });
                        textBlockStarted = true;
                    }
                    textContent += delta.content;
                    sendEvent(controller, 'content_block_delta', { type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'text_delta', text: delta.content } });
                }
                // Handle tool calls
                if (delta.tool_calls) {
                    for (const tc_delta of delta.tool_calls) {
                        const index = tc_delta.index;
                        if (!toolCalls[index]) {
                            toolCalls[index] = { id: '', name: '', args: '', claudeIndex: 0, started: false, stopped: false };
                        }
                        if (tc_delta.id)
                            toolCalls[index].id = tc_delta.id;
                        if (tc_delta.function?.name)
                            toolCalls[index].name = tc_delta.function.name;
                        if (tc_delta.function?.arguments)
                            toolCalls[index].args += tc_delta.function.arguments;
                        if (toolCalls[index].id && toolCalls[index].name && !toolCalls[index].started) {
                            // 如果是第一个 block，从 -1 递增到 0；否则递增 contentBlockIndex
                            if (contentBlockIndex === -1) {
                                contentBlockIndex = 0;
                            }
                            else {
                                contentBlockIndex++;
                            }
                            toolCalls[index].claudeIndex = contentBlockIndex;
                            toolCalls[index].started = true;
                            sendEvent(controller, 'content_block_start', { type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'tool_use', id: toolCalls[index].id, name: toolCalls[index].name, input: {} } });
                        }
                        if (toolCalls[index].started && tc_delta.function?.arguments) {
                            sendEvent(controller, 'content_block_delta', { type: 'content_block_delta', index: toolCalls[index].claudeIndex, delta: { type: 'input_json_delta', partial_json: tc_delta.function.arguments } });
                        }
                    }
                }
            }
            catch (e) {
                // Ignore JSON parse errors
            }
        }
    };
}
// --- CORS Handling ---
function handleOptions(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, Anthropic-Version');
    return res.status(200).end();
}
//# sourceMappingURL=index.js.map