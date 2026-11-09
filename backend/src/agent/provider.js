// LLM provider adapter. Every supported provider speaks the OpenAI chat-completions
// format (DeepSeek natively; Gemini, Anthropic, Groq, OpenRouter via their
// OpenAI-compatible endpoints), so one client covers all of them.
const { env } = require('../config/env');
const { decrypt } = require('../lib/crypto');
const logger = require('../lib/logger');

const DEFAULT_BASE_URL = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};
const ENV_KEY = { deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };

class LlmError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

function resolveEndpoint(cfg) {
  const base = (cfg.base_url || DEFAULT_BASE_URL[cfg.provider] || '').replace(/\/$/, '');
  if (!base) throw new LlmError('No API address for this provider: set a base URL in AI Agent settings');
  const apiKey = cfg.api_key_enc ? decrypt(cfg.api_key_enc) : env[ENV_KEY[cfg.provider]];
  if (!apiKey) throw new LlmError(`No API key: set ${ENV_KEY[cfg.provider] || 'one'} in .env or save one in AI Agent settings`);
  return { url: `${base}/chat/completions`, apiKey };
}

async function callOnce({ url, apiKey, body, timeoutMs }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LlmError(`LLM request failed: ${err.message}`, { retryable: true });
  }
  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error?.message || msg; } catch { /* not json */ }
    throw new LlmError(`LLM ${res.status}: ${msg}`, { status: res.status, retryable });
  }
  try { return JSON.parse(text); } catch { throw new LlmError('LLM returned invalid JSON', { retryable: true }); }
}

/**
 * One chat completion with tools. Retries transient errors, then tries the fallback model.
 * @param {object} cfg ai_agent_config row
 * @param {Array} messages OpenAI-format messages
 * @param {Array} tools OpenAI-format tool definitions
 * @returns {Promise<{message:{content:string|null, tool_calls?:Array}, usage:{input:number, cached:number, output:number}, model:string}>}
 */
async function chat(cfg, messages, tools, { timeoutMs = 60_000, attempts = 2 } = {}) {
  const { url, apiKey } = resolveEndpoint(cfg);
  const models = [cfg.model, cfg.fallback_model].filter(Boolean);
  let lastErr = null;
  for (const model of models) {
    const body = {
      model,
      messages,
      temperature: Number(cfg.temperature),
      max_tokens: cfg.max_output_tokens,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    };
    for (let i = 0; i < attempts; i += 1) {
      if (i) await new Promise((r) => setTimeout(r, 800 * 2 ** i));
      try {
        const data = await callOnce({ url, apiKey, body, timeoutMs });
        const choice = data.choices?.[0];
        if (!choice?.message) throw new LlmError('LLM returned no message', { retryable: true });
        const u = data.usage || {};
        return {
          model,
          message: { content: choice.message.content ?? null, tool_calls: choice.message.tool_calls || [] },
          usage: {
            input: u.prompt_tokens || 0,
            cached: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
            output: u.completion_tokens || 0,
          },
        };
      } catch (err) {
        lastErr = err;
        if (!(err instanceof LlmError) || !err.retryable) break;
      }
    }
    if (model !== models[models.length - 1]) logger.warn('LLM model failed, trying fallback', { model, error: lastErr?.message });
  }
  throw lastErr || new LlmError('LLM call failed');
}

/** Cost of one call in INR, from the per-1M-token prices in the agent config. */
function costInr(usage, pricing = {}, usdInr = 84) {
  if (!pricing || !pricing.input) return 0;
  const fresh = Math.max(0, usage.input - usage.cached);
  const amount = (fresh * pricing.input + usage.cached * (pricing.cached_input ?? pricing.input) + usage.output * pricing.output) / 1_000_000;
  return pricing.currency === 'USD' ? amount * usdInr : amount;
}

module.exports = { chat, costInr, LlmError, DEFAULT_BASE_URL };
