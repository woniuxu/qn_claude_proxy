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
interface ClaudeTool {
    name: string;
    description?: string;
    input_schema: any;
}
export interface ClaudeTextBlock {
    type: "text" | "image" | "document" | "tool_use" | "tool_result" | "thinking";
    text?: string;
    thinking?: string;
    signature?: string;
    source?: {
        type: "base64";
        media_type: string;
        data: string;
    } | {
        type: "url";
        url: string;
    };
    id?: string;
    name?: string;
    input?: any;
    tool_use_id?: string;
    content?: any;
    cache_control?: any;
}
type ClaudeContent = string | ClaudeTextBlock[];
interface ClaudeMessage {
    role: "user" | "assistant";
    content: ClaudeContent;
}
interface ClaudeOutputConfig {
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    format?: {
        type: "json_schema";
        schema: {
            [key: string]: any;
        };
    } | null;
}
export interface ClaudeMessagesRequest {
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
    tool_choice?: {
        type: "auto" | "any" | "none" | "tool";
        name?: string;
    };
    thinking?: {
        type: "enabled" | "disabled" | "adaptive";
        budget_tokens?: number;
        display?: "summarized";
    };
    output_config?: ClaudeOutputConfig;
}
export interface OpenAIContentBlock {
    type: "text" | "image_url" | "thinking" | "file";
    text?: string;
    image_url?: {
        url: string;
    };
    thinking?: string;
    signature?: string;
    file?: {
        file_id?: string;
        file_data?: string;
    };
    cache_control?: any;
}
export interface OpenAIMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | OpenAIContentBlock[];
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
    thinking_blocks?: Array<{
        type: "thinking";
        thinking: string;
        signature?: string;
    }>;
    cache_control?: any;
}
interface OpenAIToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
    cache_control?: any;
}
interface OpenAIRequest {
    model: string;
    messages: OpenAIMessage[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string[];
    stream?: boolean;
    tools?: Array<{
        type: "function";
        function: any;
    }>;
    tool_choice?: "auto" | "required" | "none" | {
        type: "function";
        function: {
            name: string;
        };
    };
    stream_options?: {
        include_usage: boolean;
    };
    thinking?: {
        type: "enabled" | "disabled" | "adaptive";
        budget_tokens?: number;
        display?: "summarized";
    };
    response_format?: {
        type: "text" | "json_object" | "json_schema";
        json_schema?: {
            name: string;
            schema: {
                [key: string]: any;
            };
            strict?: boolean;
        };
    };
    output_config?: {
        effort?: "low" | "medium" | "high" | "xhigh" | "max";
    };
}
/**
 * 将 Claude 图片块转换为 OpenAI image_url 格式
 */
export declare function convertImageBlockToOpenAI(block: ClaudeTextBlock): OpenAIContentBlock;
/**
 * Converts a Claude API request to the OpenAI format.
 */
export declare function convertClaudeToOpenAIRequest(claudeRequest: ClaudeMessagesRequest, modelName: string): OpenAIRequest;
export {};
//# sourceMappingURL=index.d.ts.map