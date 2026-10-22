import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');

loadEnv();

// ---------------------------------------------------------------------------
// Target area
// ---------------------------------------------------------------------------

export const STATES = ['NY', 'NJ', 'CT'];
export const CCD_YEAR = 2023;

// ---------------------------------------------------------------------------
// Hack Club AI
// ---------------------------------------------------------------------------

export const HC_AI_BASE = 'https://ai.hackclub.com/proxy/v1';
export const HC_API_KEY = process.env.HACK_CLUB_AI_API_KEY || '';
// A cheap, non-reasoning model that returns JSON reliably. Reasoning models
// (e.g. qwen/qwen3-32b) can spend the whole token budget on "thinking" and
// return empty content, so we avoid them by default.
export const HC_MODEL = process.env.HC_AI_MODEL || 'openai/gpt-4o-mini';

// Optional: route LLM (chat) calls through OpenRouter instead of Hack Club AI.
// Exa web search is always provided by Hack Club AI (its proxy feature).
export const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'hackclub').toLowerCase();
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_BASE = process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

// Discovery (web search) provider: 'auto' (default), 'openrouter', or 'exa'.
export const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || 'auto').toLowerCase();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const DATA_DIR = path.join(ROOT, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const SCHOOLS_FILE = path.join(DATA_DIR, 'schools.json');
export const OUTPUT_FILE = path.join(DATA_DIR, 'cs_people.json');
export const MAP_DATA_FILE = path.join(ROOT, 'map', 'data', 'cs_people.json');

// ---------------------------------------------------------------------------
// Runtime knobs
// ---------------------------------------------------------------------------

export const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
export const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 150);
