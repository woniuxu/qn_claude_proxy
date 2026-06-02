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
//# sourceMappingURL=index.old-mian.d.ts.map