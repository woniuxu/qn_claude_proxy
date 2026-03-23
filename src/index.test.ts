/**
 * 单元测试：tool_result 中图片块的格式转换
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// mock 掉有副作用的模块，避免 import index.ts 时启动 express 服务
vi.mock('express', () => {
    const handler = { get: () => vi.fn() };
    const app = new Proxy({}, handler);
    const express: any = () => app;
    express.json = () => vi.fn();
    express.Router = () => new Proxy({}, handler);
    return { default: express };
});
vi.mock('cors', () => ({ default: () => vi.fn() }));
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
vi.mock('winston', () => ({
    default: {
        createLogger: () => ({
            info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
        }),
        format: {
            combine: vi.fn(), timestamp: vi.fn(), printf: vi.fn(),
            colorize: vi.fn(), simple: vi.fn(), json: vi.fn(),
        },
        transports: { Console: vi.fn(), File: vi.fn() },
    },
}));
vi.mock('winston-daily-rotate-file', () => ({ default: vi.fn() }));

// 在 mock 之后再 import
let convertImageBlockToOpenAI: typeof import('./index').convertImageBlockToOpenAI;
let convertClaudeToOpenAIRequest: typeof import('./index').convertClaudeToOpenAIRequest;

beforeAll(async () => {
    const mod = await import('./index');
    convertImageBlockToOpenAI = mod.convertImageBlockToOpenAI;
    convertClaudeToOpenAIRequest = mod.convertClaudeToOpenAIRequest;
});

// ============================================================
// convertImageBlockToOpenAI 单元测试
// ============================================================
describe('convertImageBlockToOpenAI', () => {
    it('将 base64 图片块转为 data URL 格式的 image_url', () => {
        const block: any = {
            type: 'image',
            source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgo=',
            },
        };
        const result = convertImageBlockToOpenAI(block);
        expect(result).toEqual({
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
        });
    });

    it('将 url 图片块直接透传 URL', () => {
        const block: any = {
            type: 'image',
            source: {
                type: 'url',
                url: 'https://example.com/image.png',
            },
        };
        const result = convertImageBlockToOpenAI(block);
        expect(result).toEqual({
            type: 'image_url',
            image_url: { url: 'https://example.com/image.png' },
        });
    });

    it('透传 cache_control 字段', () => {
        const block: any = {
            type: 'image',
            source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: '/9j/4AAQ',
            },
            cache_control: { type: 'ephemeral' },
        };
        const result = convertImageBlockToOpenAI(block);
        expect(result.cache_control).toEqual({ type: 'ephemeral' });
        expect(result.type).toBe('image_url');
    });

    it('没有 cache_control 时结果不包含该字段', () => {
        const block: any = {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'abc' },
        };
        const result = convertImageBlockToOpenAI(block);
        expect(result).not.toHaveProperty('cache_control');
    });
});

// ============================================================
// tool_result 中包含图片的转换测试
// ============================================================
describe('convertClaudeToOpenAIRequest - tool_result 图片处理', () => {
    /**
     * 构造最小化的 Claude 请求体
     */
    function makeRequest(messages: any[]) {
        return {
            model: 'claude-3-opus',
            messages,
            max_tokens: 1024,
        };
    }

    it('tool_result content 仅含图片时：tool 消息为 [image]，紧跟 user 消息含 image_url', () => {
        const request = makeRequest([
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool_123',
                        content: [
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    data: 'iVBORw0KGgo=',
                                    media_type: 'image/png',
                                },
                            },
                        ],
                    },
                ],
            },
        ]);

        const result = convertClaudeToOpenAIRequest(request, 'gpt-4o');
        const messages = result.messages;

        // 第一条：tool 消息，content 为占位文本
        expect(messages[0]).toMatchObject({
            role: 'tool',
            tool_call_id: 'tool_123',
            content: '[image]',
        });

        // 第二条：user 消息，包含 image_url 块
        expect(messages[1]).toMatchObject({
            role: 'user',
            content: [
                {
                    type: 'image_url',
                    image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
                },
            ],
        });
    });

    it('tool_result content 含文本和图片时：tool 消息取文本，user 消息取图片', () => {
        const request = makeRequest([
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool_456',
                        content: [
                            { type: 'text', text: '图片描述如下' },
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    data: '/9j/4AAQ',
                                    media_type: 'image/jpeg',
                                },
                            },
                        ],
                    },
                ],
            },
        ]);

        const result = convertClaudeToOpenAIRequest(request, 'gpt-4o');
        const messages = result.messages;

        // tool 消息内容为提取的文本
        expect(messages[0]).toMatchObject({
            role: 'tool',
            tool_call_id: 'tool_456',
            content: '图片描述如下',
        });

        // user 消息包含图片
        expect(messages[1]).toMatchObject({
            role: 'user',
            content: [
                {
                    type: 'image_url',
                    image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' },
                },
            ],
        });
    });

    it('tool_result content 含多张图片时：user 消息包含所有图片', () => {
        const request = makeRequest([
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool_789',
                        content: [
                            {
                                type: 'image',
                                source: { type: 'base64', data: 'img1data', media_type: 'image/png' },
                            },
                            {
                                type: 'image',
                                source: { type: 'base64', data: 'img2data', media_type: 'image/jpeg' },
                            },
                        ],
                    },
                ],
            },
        ]);

        const result = convertClaudeToOpenAIRequest(request, 'gpt-4o');
        const messages = result.messages;

        expect(messages[0]).toMatchObject({
            role: 'tool',
            content: '[image]',
        });

        expect(messages[1]).toMatchObject({
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,img1data' } },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,img2data' } },
            ],
        });
    });

    it('tool_result content 为字符串时：行为不变，无额外 user 消息', () => {
        const request = makeRequest([
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool_str',
                        content: '纯文本结果',
                    },
                ],
            },
        ]);

        const result = convertClaudeToOpenAIRequest(request, 'gpt-4o');
        const messages = result.messages;

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            role: 'tool',
            tool_call_id: 'tool_str',
            content: '纯文本结果',
        });
    });

    it('tool_result 的 cache_control 正确透传到 tool 消息', () => {
        const request = makeRequest([
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool_cache',
                        content: [
                            {
                                type: 'image',
                                source: { type: 'base64', data: 'abc', media_type: 'image/png' },
                            },
                        ],
                        cache_control: { type: 'ephemeral' },
                    },
                ],
            },
        ]);

        const result = convertClaudeToOpenAIRequest(request, 'gpt-4o');
        const messages = result.messages;

        // tool 消息带 cache_control
        expect(messages[0].cache_control).toEqual({ type: 'ephemeral' });
        // user 消息（图片）不带 message 级别的 cache_control
        expect(messages[1]).not.toHaveProperty('cache_control');
    });

    it('tool_result content 含多个非图片块时：JSON.stringify 所有非图片块', () => {
        const request = makeRequest([
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool_multi',
                        content: [
                            { type: 'text', text: '第一段' },
                            { type: 'text', text: '第二段' },
                            {
                                type: 'image',
                                source: { type: 'base64', data: 'imgdata', media_type: 'image/png' },
                            },
                        ],
                    },
                ],
            },
        ]);

        const result = convertClaudeToOpenAIRequest(request, 'gpt-4o');
        const messages = result.messages;

        // 多个非图片块时 JSON.stringify
        const toolContent = messages[0].content as string;
        const parsed = JSON.parse(toolContent);
        expect(parsed).toEqual([
            { type: 'text', text: '第一段' },
            { type: 'text', text: '第二段' },
        ]);

        // 图片在 user 消息中
        expect(messages[1]).toMatchObject({
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,imgdata' } },
            ],
        });
    });

    it('模拟 Claude Code READ 工具读取图片的完整请求体', () => {
        // 这是 Claude Code READ 工具读取图片文件时产生的真实请求格式
        const request = makeRequest([
            {
                role: 'user',
                content: [
                    {
                        tool_use_id: 'tooluse_nDzchUYBUJkz5Ts0Us0uF1',
                        type: 'tool_result',
                        content: [
                            {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                                    media_type: 'image/png',
                                },
                            },
                        ],
                        cache_control: {
                            type: 'ephemeral',
                        },
                    },
                ],
            },
        ]);

        const result = convertClaudeToOpenAIRequest(request, 'gemini-3.0-pro-preview');

        // 验证 tool 消息
        expect(result.messages[0]).toMatchObject({
            role: 'tool',
            tool_call_id: 'tooluse_nDzchUYBUJkz5Ts0Us0uF1',
            content: '[image]',
            cache_control: { type: 'ephemeral' },
        });

        // 验证紧跟的 user 消息包含标准 image_url 格式
        expect(result.messages[1]).toMatchObject({
            role: 'user',
            content: [
                {
                    type: 'image_url',
                    image_url: {
                        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    },
                },
            ],
        });

        // 确保模型名称正确
        expect(result.model).toBe('gemini-3.0-pro-preview');
    });
});
