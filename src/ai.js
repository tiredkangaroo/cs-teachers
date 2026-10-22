import {
  HC_AI_BASE,
  HC_API_KEY,
  HC_MODEL,
  LLM_PROVIDER,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE,
  OPENROUTER_MODEL,
  SEARCH_PROVIDER,
} from './config.js';
import { httpJson, extractJson } from './utils.js';

function authError(which) {
  const err = new Error(`${which} is not set. Add it to .env`);
  err.code = 'AUTH';
  return err;
}

/** Resolve the active LLM endpoint, key, and default model. */
function llmTarget() {
  if (LLM_PROVIDER === 'openrouter') {
    if (!OPENROUTER_API_KEY) throw authError('OPENROUTER_API_KEY');
    return { base: OPENROUTER_BASE, key: OPENROUTER_API_KEY, model: OPENROUTER_MODEL };
  }
  if (!HC_API_KEY) throw authError('HACK_CLUB_AI_API_KEY');
  return { base: HC_AI_BASE, key: HC_API_KEY, model: HC_MODEL };
}

/** Exa web search is provided exclusively by the Hack Club AI proxy. */
function exaHeaders() {
  if (!HC_API_KEY) throw authError('HACK_CLUB_AI_API_KEY (Exa web search is a Hack Club AI feature)');
  return {
    Authorization: `Bearer ${HC_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Non-streaming chat completion. Returns the assistant text content.
 * Routes to Hack Club AI or OpenRouter based on LLM_PROVIDER.
 */
export async function chat(messages, { model, temperature = 0, maxTokens = 3000 } = {}) {
  const t = llmTarget();
  const headers = {
    Authorization: `Bearer ${t.key}`,
    'Content-Type': 'application/json',
  };
  if (LLM_PROVIDER === 'openrouter') {
    headers['HTTP-Referer'] = 'https://localhost';
    headers['X-Title'] = 'cs-teachers-tristate';
  }
  const body = { model: model || t.model, messages, temperature, max_tokens: maxTokens };
  const res = await httpJson(`${t.base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const content = res?.choices?.[0]?.message?.content;
  if (!content) {
    const msg = res?.choices?.[0]?.message;
    if (msg?.reasoning && !msg?.content) {
      const err = new Error(
        `Model ${body.model} returned reasoning but empty content (likely a reasoning model). ` +
          'Set HC_AI_MODEL / OPENROUTER_MODEL to a non-reasoning model.',
      );
      err.code = 'AI_EMPTY';
      throw err;
    }
    const err = new Error('Empty AI response: ' + JSON.stringify(res).slice(0, 500));
    err.code = 'AI_EMPTY';
    throw err;
  }
  return content;
}

/** Chat completion that returns a parsed JSON object/array (with robust fallback). */
export async function chatJson(messages, opts = {}) {
  const content = await chat(messages, opts);
  const parsed = extractJson(content);
  if (parsed === null) {
    const err = new Error('AI did not return parseable JSON. Raw: ' + content.slice(0, 500));
    err.code = 'AI_JSON';
    err.raw = content;
    throw err;
  }
  return parsed;
}

/**
 * Exa web search through the Hack Club proxy. Returns an array of result
 * objects, each with `url`, `title`, and (when text is requested) `text`.
 */
export async function exaSearch(query, { numResults = 4, maxChars = 20000, type } = {}) {
  const body = { query, numResults, contents: { text: { maxCharacters: maxChars } } };
  if (type) body.type = type;
  const res = await httpJson(`${HC_AI_BASE}/exa/search`, {
    method: 'POST',
    headers: exaHeaders(),
    body: JSON.stringify(body),
  });
  return res?.results || [];
}

/** Exa contents extraction: get clean text for one or more URLs. */
export async function exaContents(urls, { maxChars = 30000 } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  const res = await httpJson(`${HC_AI_BASE}/exa/contents`, {
    method: 'POST',
    headers: exaHeaders(),
    body: JSON.stringify({ urls: list, text: { maxCharacters: maxChars } }),
  });
  return res?.results || [];
}

// ---------------------------------------------------------------------------
// OpenRouter web search (replaces Exa, so discovery doesn't need Hack Club AI)
// ---------------------------------------------------------------------------

function openrouterHeaders() {
  if (!OPENROUTER_API_KEY) throw authError('OPENROUTER_API_KEY');
  return {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://localhost',
    'X-Title': 'cs-teachers-tristate',
  };
}

/**
 * Web search via OpenRouter's `:online` models. Returns an array of
 * `{url, title, text}` — the pages the search found, with their extracted text
 * (from the response's `annotations` / `url_citation` entries).
 */
export async function openrouterWebSearch(query, { model } = {}) {
  const m = model || OPENROUTER_MODEL;
  const body = {
    model: m.endsWith(':online') ? m : `${m}:online`,
    messages: [{ role: 'user', content: query }],
  };
  const res = await httpJson(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: openrouterHeaders(),
    body: JSON.stringify(body),
  });
  const annotations = res?.choices?.[0]?.message?.annotations || [];
  const out = [];
  for (const a of annotations) {
    const c = a?.url_citation;
    if (a?.type === 'url_citation' && c?.url) {
      out.push({ url: c.url, title: c.title || '', text: c.content || '' });
    }
  }
  return out;
}

/**
 * Unified web search used by discovery. Provider is chosen by SEARCH_PROVIDER:
 *   'openrouter' -> OpenRouter :online search (default when an OpenRouter key is set)
 *   'exa'        -> Hack Club AI Exa proxy
 *   'auto'       -> OpenRouter if a key is present, otherwise Exa
 * All return `[{url, title, text}]`.
 */
export async function webSearch(query, opts = {}) {
  if (SEARCH_PROVIDER === 'exa') return exaSearch(query, opts);
  if (SEARCH_PROVIDER === 'openrouter') return openrouterWebSearch(query, opts);
  if (OPENROUTER_API_KEY) return openrouterWebSearch(query, opts);
  return exaSearch(query, opts);
}
