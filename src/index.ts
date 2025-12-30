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

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

// --- TYPE DEFINITIONS ---

/**
 * Environment variables configured in your .env file.
 */
export interface Env {
    /**
     * Pre-configured route for a "haiku" model for easier access.
     */
    OPENAI_BASE_URL: string;
    OPENAI_API_KEY?: string;
    PORT: string;
}

// --- Claude API Types ---

interface ClaudeTool {
    name: string;
    description?: string;
    input_schema: any;
}

type ClaudeContent =
    | string
    | Array<{
    type: "text" | "image" | "tool_use" | "tool_result" | "thinking";
    text?: string;
    thinking?: string;
    signature?: string;
    source?: {
        type: "base64";
        media_type: string;
        data: string;
    };
    id?: string;
    name?: string;
    input?: any;
    tool_use_id?: string;
    content?: any;
}>;

interface ClaudeMessage {
    role: "user" | "assistant";
    content: ClaudeContent;
}

interface ClaudeMessagesRequest {
    model: string;
    messages: ClaudeMessage[];
    system?: string;
    max_tokens: number;
    stop_sequences?: string[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    tools?: ClaudeTool[];
    tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
    thinking?: {
        type: "enabled" | "disabled";
        budget_tokens?: number;
    };
}

// --- OpenAI API Types ---

interface OpenAIMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | Array<{
        type: "text" | "image_url" | "thinking";
        text?: string;
        image_url?: { url: string };
        thinking?: string;
        signature?: string;
    }>;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
    thinking_blocks?: Array<{ type: "thinking"; thinking: string; signature?: string }>;
}

interface OpenAIToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

interface OpenAIRequest {
    model: string;
    messages: OpenAIMessage[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string[];
    stream?: boolean;
    tools?: Array<{ type: "function"; function: any }>;
    tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
    stream_options?: { include_usage: boolean };
    thinking?: {
        type: "enabled" | "disabled";
        budget_tokens?: number;
    };
}

// --- Express App Setup ---

const app = express();
const PORT = process.env.PORT || 8092;

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 获取环境变量
const env: Env = {
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

    const authHeader = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
    const bearerMatch = authHeader && authHeader.match(/^Bearer\s+(.+)$/i);
    const apiKey = (bearerMatch && bearerMatch[1]) || (req.headers['x-api-key'] as string);
    if (!apiKey) {
        return res.status(401).json({ error: 'Missing API key. Provide Authorization: Bearer <key> or x-api-key header.' });
    }

    try {
        const claudeRequest: ClaudeMessagesRequest = req.body;

        // --- Configuration Selection ---
        let targetApiKey = apiKey;
        let targetModelName: string;
        let targetBaseUrl: string;

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
        // 组装上游请求 headers，并透传下游的 X-Real-IP、User-Agent 和 Referer
        const upstreamHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${target.apiKey}`,
        };
        const realIpHeader = req.headers['x-real-ip'] as string | string[] | undefined;
        if (realIpHeader) {
            upstreamHeaders['X-Real-IP'] = Array.isArray(realIpHeader) ? realIpHeader[0] : realIpHeader;
        }
        const userAgentHeader = req.headers['user-agent'] as string | string[] | undefined;
        if (userAgentHeader) {
            upstreamHeaders['User-Agent'] = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
        }
        const refererHeader = req.headers['referer'] as string | string[] | undefined;
        if (refererHeader) {
            upstreamHeaders['Referer'] = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
        }

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
                transform: streamTransformer(claudeRequest.model),
            });

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            // 将 OpenAI 响应流通过转换流传递给客户端
            if (openaiApiResponse.body) {
                openaiApiResponse.body.pipeThrough(transformStream).pipeTo(
                    new WritableStream({
                        write(chunk) {
                            res.write(chunk);
                        },
                        close() {
                            res.end();
                        }
                    })
                );
            }
        } else {
            const openaiResponse = await openaiApiResponse.json();
            const claudeResponse = convertOpenAIToClaudeResponse(openaiResponse, claudeRequest.model);
            return res.json(claudeResponse);
        }
    } catch (e: any) {
        console.error('Error processing request:', e);
        return res.status(500).json({ error: e.message });
    }
});

// 健康检查端点
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
function recursivelyCleanSchema(schema: any): any {
    if (schema === null || typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => recursivelyCleanSchema(item));
    }

    const newSchema: { [key: string]: any } = {};
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
 * Converts a Claude API request to the OpenAI format.
 */
function convertClaudeToOpenAIRequest(
    claudeRequest: ClaudeMessagesRequest,
    modelName: string
): OpenAIRequest {
    const openaiMessages: OpenAIMessage[] = [];

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
                        openaiMessages.push({
                            role: 'tool',
                            tool_call_id: block.tool_use_id!,
                            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                        });
                    });
                }

                if (otherContent.length > 0) {
                    openaiMessages.push({ role: "user", content: otherContent.map(block => block.type === 'text' ? {type: 'text', text: block.text} : {type: 'image_url', image_url: {url: `data:${block.source!.media_type};base64,${block.source!.data}`}} ) as any});
                }
            } else {
                openaiMessages.push({ role: "user", content: message.content });
            }
        } else if (message.role === 'assistant') {
            const contentBlocks: Array<{ type: "text" | "thinking"; text?: string; thinking?: string; signature?: string }> = [];
            const toolCalls: OpenAIToolCall[] = [];
            if (Array.isArray(message.content)) {
                message.content.forEach(block => {
                    if (block.type === 'text') {
                        contentBlocks.push({ type: 'text', text: block.text! });
                    } else if (block.type === 'thinking') {
                        // Preserve thinking blocks in OpenAI format with signature
                        const thinkingBlock: { type: 'thinking'; thinking: string; signature?: string } = {
                            type: 'thinking',
                            thinking: block.thinking || block.text || ''
                        };
                        if (block.signature) {
                            thinkingBlock.signature = block.signature;
                        }
                        contentBlocks.push(thinkingBlock);
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id!,
                            type: 'function',
                            function: { name: block.name!, arguments: JSON.stringify(block.input || {}) },
                        });
                    }
                });
            }

            // If we have structured content blocks (thinking or multiple text blocks), use array format
            // Otherwise, use simple string format for backward compatibility
            let content: string | Array<{ type: "text" | "thinking"; text?: string; thinking?: string; signature?: string }>;
            if (contentBlocks.length === 0) {
                content = '';
            } else if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') {
                content = contentBlocks[0].text || '';
            } else {
                content = contentBlocks;
            }

            const assistantMessage: OpenAIMessage = { role: 'assistant', content };
            if (toolCalls.length > 0) {
                assistantMessage.tool_calls = toolCalls;
            }
            openaiMessages.push(assistantMessage);
        }
    }

    const openaiRequest: OpenAIRequest = {
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
        if (claudeRequest.tool_choice.type === 'auto' || claudeRequest.tool_choice.type === 'any') {
            openaiRequest.tool_choice = 'auto';
        } else if (claudeRequest.tool_choice.type === 'tool') {
            openaiRequest.tool_choice = { type: 'function', function: { name: claudeRequest.tool_choice.name! }};
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
function convertOpenAIToClaudeResponse(openaiResponse: any, model: string): any {
    const mapOpenAIIdToClaude = (openaiId: string): string => {
        if (!openaiId || typeof openaiId !== 'string') return `msg_${Math.random().toString(36).substr(2, 9)}`;
        const match = openaiId.match(/^[a-zA-Z]+-([A-Za-z0-9_\-]+)/);
        const suffix = match ? match[1] : openaiId;
        return `msg_${suffix}`;
    };
    // 提取 id 的后缀部分（去掉前缀），用于签名
    const extractIdSuffix = (id: string): string => {
        if (!id || typeof id !== 'string') return '';
        const match = id.match(/^[a-zA-Z]+-([A-Za-z0-9_\-]+)/);
        return match ? match[1] : id;
    };
    const choice = openaiResponse.choices[0];
    const contentBlocks: any[] = [];
    const messageId = mapOpenAIIdToClaude(openaiResponse.id);
    const originalId = openaiResponse.id; // 原始的 OpenAI id，用于签名

    // Handle thinking blocks first (they should appear before text content in Claude format)
    // 如果 thinking_blocks 存在，优先使用 thinking_blocks
    if (choice.message.thinking_blocks && choice.message.thinking_blocks.length > 0) {
        choice.message.thinking_blocks.forEach((block: { type: string; thinking: string; signature?: string }) => {
            const thinkingBlock: { type: 'thinking'; thinking: string; signature?: string } = {
                type: 'thinking',
                thinking: block.thinking,
            };
            // thinking_blocks 存在时，使用 block 的 signature 或原始 id
            if (block.signature) {
                thinkingBlock.signature = block.signature;
            }
            contentBlocks.push(thinkingBlock);
        });
    } else if (choice.message.reasoning_content) {
        // thinking_blocks 不存在时，使用 reasoning_content，签名使用 id 后缀（去掉前缀）
        const thinkingBlock: { type: 'thinking'; thinking: string; signature: string } = {
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
        choice.message.tool_calls.forEach((call: OpenAIToolCall) => {
            contentBlocks.push({
                type: 'tool_use',
                id: call.id,
                name: call.function.name,
                input: JSON.parse(call.function.arguments),
            });
        });
    }
    const stopReasonMap: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
    console.log(`messageId: ${messageId}`);
    return {
        id: messageId,
        type: "message",
        role: "assistant",
        model: model,
        content: contentBlocks,
        stop_reason: stopReasonMap[choice.finish_reason] || "end_turn",
        usage: {
            input_tokens: openaiResponse.usage.prompt_tokens,
            output_tokens: openaiResponse.usage.completion_tokens,
        },
    };
}

/**
 * Creates a transform function for the streaming response.
 * Handles OpenAI streaming format including thinking_blocks and converts to Claude SSE format.
 */
function streamTransformer(model: string) {
    const mapOpenAIIdToClaude = (openaiId: string): string => {
        if (!openaiId || typeof openaiId !== 'string') return `msg_${Math.random().toString(36).substr(2, 9)}`;
        const match = openaiId.match(/^[a-zA-Z]+-([A-Za-z0-9_\-]+)/);
        const suffix = match ? match[1] : openaiId;
        return `msg_${suffix}`;
    };
    // 提取 id 的后缀部分（去掉前缀），用于 reasoning_content 的签名
    const extractIdSuffix = (id: string | null): string => {
        if (!id || typeof id !== 'string') return '';
        const match = id.match(/^[a-zA-Z]+-([A-Za-z0-9_\-]+)/);
        return match ? match[1] : id;
    };
    let initialized = false;
    let buffer = "";
    let messageId: string | null = null;
    let requestId: string | null = null; // Store original OpenAI request id for signature
    const toolCalls: { [index: number]: { id: string, name: string, args: string, claudeIndex: number, started: boolean, stopped: boolean } } = {};
    const thinkingBlocks: { [index: number]: { content: string, claudeIndex: number, started: boolean, stopped: boolean, signature?: string } } = {};
    let contentBlockIndex = -1; // Start at -1, will be incremented to 0 for first block
    let textBlockStarted = false; // Track if text block has been started
    let textContent = '';
    let reasoningBlockStarted = false; // Track if reasoning_content block has been started
    let reasoningContent = ''; // Track reasoning_content content
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let inputTokens = 0;
    let outputTokens = 0;
    let lastDelta: any = null; // Track last delta to detect transitions
    const sendEvent = (controller: TransformStreamDefaultController, event: string, data: object) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };
    return (chunk: Uint8Array, controller: TransformStreamDefaultController) => {
        const stopThinkingBlock = (thinkingIndex: number) => {
            const tb = thinkingBlocks[thinkingIndex];
            if (tb && tb.started && !tb.stopped) {
                sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: tb.claudeIndex });
                tb.stopped = true;
                // 每结束一个块就递增 index
                contentBlockIndex++;
            }
        };
        const stopTextBlock = () => {
            if (textBlockStarted) {
                sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: contentBlockIndex });
                textBlockStarted = false;
                // 每结束一个块就递增 index
                contentBlockIndex++;
            }
        };
        const stopToolBlock = (toolIndex: number) => {
            const tc = toolCalls[toolIndex];
            if (tc && tc.started && !tc.stopped) {
                sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: tc.claudeIndex });
                tc.stopped = true;
                // 每结束一个块就递增 index
                contentBlockIndex++;
            }
        };
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        // removed per-chunk reinitialization of inputTokens/outputTokens to preserve totals across chunks
        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
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
                    // 每结束一个块就递增 index
                    contentBlockIndex++;
                }
                Object.keys(thinkingBlocks).forEach(key => stopThinkingBlock(Number(key)));
                stopTextBlock();
                Object.keys(toolCalls).forEach(key => stopToolBlock(Number(key)));

                let finalStopReason = "end_turn";
                try {
                    const lastChunk = JSON.parse(lines[lines.length - 2].substring(6));
                    const finishReason = lastChunk.choices[0].finish_reason;
                    if (finishReason === 'tool_calls') finalStopReason = 'tool_use';
                    if (finishReason === 'length') finalStopReason = 'max_tokens';
                } catch {
                    // Ignore parsing errors for finish_reason
                }

                // 构建完整的 Claude 响应内容
                const claudeContent: any[] = [];
                // Add reasoning_content as thinking block if present
                if (reasoningContent) {
                    const reasoningBlock: any = { type: 'thinking', thinking: reasoningContent };
                    // reasoning_content 的签名使用 id 后缀（去掉前缀）
                    const signatureValue = extractIdSuffix(requestId || messageId);
                    if (signatureValue) {
                        reasoningBlock.signature = signatureValue;
                    }
                    claudeContent.push(reasoningBlock);
                }
                Object.values(thinkingBlocks).forEach(tb => {
                    if (tb.started && tb.content) {
                        const block: any = { type: 'thinking', thinking: tb.content };
                        if (tb.signature) block.signature = tb.signature;
                        claudeContent.push(block);
                    }
                });
                if (textContent) {
                    claudeContent.push({ type: 'text', text: textContent });
                }
                Object.values(toolCalls).forEach(tc => {
                    if (tc.started) {
                        let parsedInput: any = {};
                        const rawArgs = tc.args;
                        if (typeof rawArgs === 'string' && rawArgs.trim().length > 0) {
                            try {
                                parsedInput = JSON.parse(rawArgs);
                            } catch (err) {
                                // 避免因为工具参数 JSON 不完整/不合法导致整个流崩溃，同时打点方便排查
                                console.warn('[streamTransformer] Failed to parse tool call args, returning raw string instead', {
                                    err,
                                    requestId,
                                    messageId,
                                    toolCallId: tc.id,
                                    toolName: tc.name,
                                    rawArgs,
                                });
                                parsedInput = { _raw: rawArgs };
                            }
                        }

                        claudeContent.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.name,
                            input: parsedInput
                        });
                    }
                });

                sendEvent(controller, 'message_delta', { type: 'message_delta', delta: { stop_reason: finalStopReason, stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
                sendEvent(controller, 'message_stop', { type: 'message_stop' });
                controller.terminate();
                return;
            }
            try {
                const openaiChunk = JSON.parse(data);
                const delta = openaiChunk.choices[0]?.delta;

                // 第一次解析：获取 id 或备用占位 id，并发送 message_start
                if (!initialized) {
                    if (openaiChunk.id) {
                        requestId = openaiChunk.id; // Store original id for signature
                        messageId = mapOpenAIIdToClaude(openaiChunk.id);
                    } else {
                        messageId = `msg_${Math.random().toString(36).substr(2, 9)}`;
                    }
                    console.log(`messageId: ${messageId}`);
                    sendEvent(controller, 'message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
                    initialized = true;
                }

                if (openaiChunk.usage) {
                    const { prompt_tokens, completion_tokens } = openaiChunk.usage;
                    if (typeof prompt_tokens === 'number') {
                        inputTokens = Math.max(inputTokens, prompt_tokens);
                    }
                    if (typeof completion_tokens === 'number') {
                        outputTokens = Math.max(outputTokens, completion_tokens);
                    }
                    // Log each time usage appears in the stream
                    // console.log('[stream usage]', { prompt_tokens, completion_tokens, inputTokens, outputTokens });
                }
                if (!delta) continue;

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
                    // 每结束一个块就递增 index
                    contentBlockIndex++;
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
                    for(const thinking_delta of delta.thinking_blocks) {
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
                                // 如果是第一个 block，从 -1 递增到 0
                                if (contentBlockIndex === -1) {
                                    contentBlockIndex = 0;
                                }
                                thinkingBlocks[thinkingIndex].claudeIndex = contentBlockIndex;
                                thinkingBlocks[thinkingIndex].started = true;
                                thinkingBlocks[thinkingIndex].stopped = false;
                                // Include signature in content_block_start if available
                                const contentBlock: any = { type: 'thinking', thinking: '' };
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
                        // 如果是第一个 block，从 -1 递增到 0
                        if (contentBlockIndex === -1) {
                            contentBlockIndex = 0;
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
                        // 如果是第一个 block，从 -1 递增到 0
                        if (contentBlockIndex === -1) {
                            contentBlockIndex = 0;
                        }
                        sendEvent(controller, 'content_block_start', { type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'text', text: '' } });
                        textBlockStarted = true;
                    }
                    textContent += delta.content;
                    sendEvent(controller, 'content_block_delta', { type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'text_delta', text: delta.content } });
                }

                // Handle tool calls
                if (delta.tool_calls) {
                    for(const tc_delta of delta.tool_calls) {
                        const index = tc_delta.index;
                        if (!toolCalls[index]) {
                            toolCalls[index] = { id: '', name: '', args: '', claudeIndex: 0, started: false, stopped: false };
                        }
                        if (tc_delta.id) toolCalls[index].id = tc_delta.id;
                        if (tc_delta.function?.name) toolCalls[index].name = tc_delta.function.name;
                        if (tc_delta.function?.arguments) toolCalls[index].args += tc_delta.function.arguments;
                        if (toolCalls[index].id && toolCalls[index].name && !toolCalls[index].started) {
                            // 如果是第一个 block，从 -1 递增到 0
                            if (contentBlockIndex === -1) {
                                contentBlockIndex = 0;
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
            } catch (e) {
                // Ignore JSON parse errors
            }
        }
    };
}

// --- CORS Handling ---

function handleOptions(res: express.Response) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, Anthropic-Version');
    return res.status(200).end();
}
