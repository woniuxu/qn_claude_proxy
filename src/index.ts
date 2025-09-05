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
    type: "text" | "image" | "tool_use" | "tool_result";
    text?: string;
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
}

// --- OpenAI API Types ---

interface OpenAIMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }>;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
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

    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) {
        return res.status(401).json({ error: 'The "x-api-key" header is missing.' });
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
        console.log(`openaiRequest: ${JSON.stringify(openaiRequest)}`);
        console.log(`target.baseUrl: ${target.baseUrl}`);
        console.log(`target.apiKey: ${target.apiKey}`);
        const openaiApiResponse = await fetch(`${target.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${target.apiKey}`,
            },
            body: JSON.stringify(openaiRequest),
        });

        if (!openaiApiResponse.ok) {
            const errorBody = await openaiApiResponse.text();
            return res.status(openaiApiResponse.status).json(JSON.parse(errorBody));
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
            const textParts: string[] = [];
            const toolCalls: OpenAIToolCall[] = [];
            if (Array.isArray(message.content)) {
                message.content.forEach(block => {
                    if (block.type === 'text') {
                        textParts.push(block.text!);
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id!,
                            type: 'function',
                            function: { name: block.name!, arguments: JSON.stringify(block.input || {}) },
                        });
                    }
                });
            }
            const assistantMessage: OpenAIMessage = { role: 'assistant', content: textParts.join('\n') || null as any};
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
    const choice = openaiResponse.choices[0];
    const contentBlocks: any[] = [];
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
    return {
        id: openaiResponse.id,
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
 */
function streamTransformer(model: string) {
    let initialized = false;
    let buffer = "";
    const messageId = `msg_${Math.random().toString(36).substr(2, 9)}`;
    const toolCalls: { [index: number]: { id: string, name: string, args: string, claudeIndex: number, started: boolean } } = {};
    let contentBlockIndex = 0;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let inputTokens = 0;
    let outputTokens = 0;
    const sendEvent = (controller: TransformStreamDefaultController, event: string, data: object) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };
    return (chunk: Uint8Array, controller: TransformStreamDefaultController) => {
        if (!initialized) {
            sendEvent(controller, 'message_start', { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
            sendEvent(controller, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            initialized = true;
        }
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        // removed per-chunk reinitialization of inputTokens/outputTokens to preserve totals across chunks
        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.substring(6);
            if (data.trim() === "[DONE]") {
                sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: 0 });
                Object.values(toolCalls).forEach(tc => {
                    if(tc.started) sendEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: tc.claudeIndex });
                });
                let finalStopReason = "end_turn";
                try {
                    const lastChunk = JSON.parse(lines[lines.length - 2].substring(6));
                    const finishReason = lastChunk.choices[0].finish_reason;
                    if (finishReason === 'tool_calls') finalStopReason = 'tool_use';
                    if (finishReason === 'length') finalStopReason = 'max_tokens';
                } catch {}
                // Log final usage at stream end
                // console.log('[stream end] usage', { inputTokens, outputTokens });
                sendEvent(controller, 'message_delta', { type: 'message_delta', delta: { stop_reason: finalStopReason, stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
                sendEvent(controller, 'message_stop', { type: 'message_stop' });
                controller.terminate();
                return;
            }
            try {
                const openaiChunk = JSON.parse(data);
                const delta = openaiChunk.choices[0]?.delta;
                
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
                if (delta.content) {
                    sendEvent(controller, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
                }
                if (delta.tool_calls) {
                    for(const tc_delta of delta.tool_calls) {
                        const index = tc_delta.index;
                        if (!toolCalls[index]) {
                            toolCalls[index] = { id: '', name: '', args: '', claudeIndex: 0, started: false };
                        }
                        if (tc_delta.id) toolCalls[index].id = tc_delta.id;
                        if (tc_delta.function?.name) toolCalls[index].name = tc_delta.function.name;
                        if (tc_delta.function?.arguments) toolCalls[index].args += tc_delta.function.arguments;
                        if (toolCalls[index].id && toolCalls[index].name && !toolCalls[index].started) {
                            contentBlockIndex++;
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
