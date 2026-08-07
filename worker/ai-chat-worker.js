/**
 * AI Chat Worker for zhchxiao123.github.io
 *
 * Endpoints:
 *   - OPTIONS *             CORS preflight
 *   - POST /api/chat        Streaming chat with context + history
 *   - GET  /api/health      Health check
 *
 * Env variables (set via wrangler secret or Cloudflare dashboard):
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY
 * Env vars (set via wrangler.toml [vars]):
 *   MODEL_PROVIDER, MODEL_NAME, ALLOWED_ORIGINS, RATE_LIMIT_PER_HOUR, MAX_MESSAGE_LENGTH
 */

const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'groq'];

function getCorsHeaders(request, allowedOrigins) {
  const origin = request.headers.get('Origin') || '';
  const allowed = allowedOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowOrigin =
    allowed.includes(origin) || allowed.includes('*') ? origin || '*' : allowed[0] || 'https://zhchxiao123.github.io';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

function getClientIP(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  );
}

function makeKey(ip) {
  return `rate_limit:${ip}`;
}

async function checkRateLimit(request, env) {
  const limit = parseInt(env.RATE_LIMIT_PER_HOUR || '30', 10);
  if (!env.RATE_LIMIT || limit <= 0) return { ok: true };

  const ip = getClientIP(request);
  const key = makeKey(ip);
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour

  const stored = await env.RATE_LIMIT.getWithMetadata(key);
  const count = stored.value ? parseInt(stored.value, 10) : 0;
  const meta = stored.metadata || {};
  const resetAt = meta.resetAt || now + windowMs;

  if (now > resetAt) {
    await env.RATE_LIMIT.put(key, '1', { metadata: { resetAt: now + windowMs }, expirationTtl: 3600 });
    return { ok: true, remaining: limit - 1 };
  }

  if (count >= limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((resetAt - now) / 1000) };
  }

  await env.RATE_LIMIT.put(key, String(count + 1), { metadata: { resetAt }, expirationTtl: 3600 });
  return { ok: true, remaining: limit - count - 1 };
}

function buildSystemPrompt() {
  return `你是一个 helpful 的 AI 助手，正在回答读者关于博客文章的问题。

回答要求：
1. 基于用户提供的上下文（选中文字、所在段落、文章标题）进行回答。
2. 如果上下文足以回答问题，请直接、简洁地回答，必要时给出例子。
3. 如果上下文不足，请明确说明“根据当前上下文我无法确定”，不要编造。
4. 保持中文回答，除非用户用其他语言提问。
5. 对技术概念解释清楚，对代码片段给出说明。`;
}

function buildUserPrompt(message, context) {
  const parts = [];
  parts.push(`文章标题：${context.pageTitle || '未提供'}`);
  if (context.pageUrl) parts.push(`文章链接：${context.pageUrl}`);
  if (context.surroundingParagraph) {
    parts.push(`\n当前段落上下文：\n${context.surroundingParagraph}`);
  }
  if (context.selectedText) {
    parts.push(`\n用户选中的内容：\n${context.selectedText}`);
  }
  if (context.relevantChunks && context.relevantChunks.length > 0) {
    parts.push(`\n相关背景片段：\n${context.relevantChunks.map((c, i) => `[${i + 1}] ${c.heading ? c.heading + ': ' : ''}${c.text}`).join('\n\n')}`);
  }
  parts.push(`\n用户问题：${message}`);
  return parts.join('\n');
}

function buildMessages(message, context, history) {
  const messages = [{ role: 'system', content: buildSystemPrompt() }];

  for (const h of history || []) {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: h.content });
    }
  }

  messages.push({ role: 'user', content: buildUserPrompt(message, context) });
  return messages;
}

async function* streamAnthropic(apiKey, model, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: messages.slice(1), // Anthropic doesn't allow system message in messages array
      system: messages[0].content,
      stream: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const data = JSON.parse(dataStr);
        if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
          yield data.delta.text;
        }
      } catch {
        // ignore malformed SSE lines
      }
    }
  }
}

async function* streamOpenAICompatible(url, apiKey, model, messages, extraBody = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: 1024,
      ...extraBody,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const data = JSON.parse(dataStr);
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // ignore malformed SSE lines
      }
    }
  }
}

function createSSEStream(generator) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of generator) {
          const data = JSON.stringify({ chunk });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.enqueue(encoder.encode('data: {"done":true}\n\n'));
      } catch (err) {
        const data = JSON.stringify({ error: err.message });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return stream;
}

async function handleChat(request, env) {
  const corsHeaders = getCorsHeaders(request, env.ALLOWED_ORIGINS || '*');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  // Rate limit
  if (env.RATE_LIMIT) {
    const rate = await checkRateLimit(request, env);
    if (!rate.ok) {
      return jsonResponse(
        { error: 'Rate limit exceeded. Please try again later.' },
        429,
        { ...corsHeaders, 'Retry-After': String(rate.retryAfter) }
      );
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const { message, context = {}, history = [] } = body;

  if (!message || typeof message !== 'string') {
    return jsonResponse({ error: 'Missing message' }, 400, corsHeaders);
  }

  const maxLen = parseInt(env.MAX_MESSAGE_LENGTH || '2000', 10);
  if (message.length > maxLen) {
    return jsonResponse({ error: `Message too long (max ${maxLen} chars)` }, 400, corsHeaders);
  }

  const provider = (env.MODEL_PROVIDER || 'groq').toLowerCase();
  const model = env.MODEL_NAME || 'llama-3.3-70b-versatile';

  const messages = buildMessages(message, context, history);

  let generator;
  try {
    if (provider === 'anthropic') {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
      generator = streamAnthropic(key, model, messages);
    } else if (provider === 'openai') {
      const key = env.OPENAI_API_KEY;
      if (!key) throw new Error('OPENAI_API_KEY not configured');
      generator = streamOpenAICompatible('https://api.openai.com/v1/chat/completions', key, model, messages);
    } else if (provider === 'groq') {
      const key = env.GROQ_API_KEY;
      if (!key) throw new Error('GROQ_API_KEY not configured');
      generator = streamOpenAICompatible('https://api.groq.com/openai/v1/chat/completions', key, model, messages);
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, corsHeaders);
  }

  const stream = createSSEStream(generator);
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...corsHeaders,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/chat') {
        return await handleChat(request, env);
      }

      if (path === '/api/health') {
        return jsonResponse({ status: 'ok', provider: env.MODEL_PROVIDER || 'groq' }, 200, getCorsHeaders(request, env.ALLOWED_ORIGINS || '*'));
      }

      return jsonResponse({ error: 'Not found' }, 404, getCorsHeaders(request, env.ALLOWED_ORIGINS || '*'));
    } catch (err) {
      return jsonResponse({ error: 'Internal error', detail: err.message }, 500, getCorsHeaders(request, env.ALLOWED_ORIGINS || '*'));
    }
  },
};
