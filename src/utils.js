import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Minimal .env loader (avoids a dotenv dependency). Does not overwrite real env. */
export function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key]) continue;
    process.env[key] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch wrapper with timeout, retry/backoff, and special handling for 402/429. */
export async function httpFetch(url, opts = {}, retries = 4) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: {
          'User-Agent': 'cs-teachers-tool/1.0 (school staff outreach research)',
          ...(opts.headers || {}),
        },
        signal: AbortSignal.timeout(45_000),
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || Math.min(90, 2 ** (i + 2));
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status === 402) {
        const err = new Error(
          'API spending/credit limit reached (402). Re-run later — progress is cached and will resume.',
        );
        err.code = 'SPEND_LIMIT';
        throw err;
      }
      if (res.status === 401 || res.status === 403) {
        const err = new Error(`Hack Club AI auth error (${res.status}). Check HACK_CLUB_AI_API_KEY in .env`);
        err.code = 'AUTH';
        throw err;
      }
      if (res.status >= 500) {
        await sleep(1000 * 2 ** i);
        continue;
      }
      return res;
    } catch (e) {
      if (e?.code === 'SPEND_LIMIT' || e?.code === 'AUTH') throw e;
      lastErr = e;
      await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}

export async function httpJson(url, opts = {}, retries = 4) {
  const res = await httpFetch(url, opts, retries);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
    err.code = 'HTTP';
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function httpText(url, opts = {}, retries = 3) {
  const res = await httpFetch(url, opts, retries);
  return res.text();
}

// ---------------------------------------------------------------------------
// Text / HTML helpers
// ---------------------------------------------------------------------------

export function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0?39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#x2F;/gi, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const GENERIC_LOCAL = new Set([
  'info', 'contact', 'contactus', 'webmaster', 'admin', 'administrator', 'office',
  'noreply', 'no-reply', 'donotreply', 'notifications', 'alerts', 'hello', 'support',
  'help', 'mail', 'postmaster', 'sales', 'privacy', 'abuse', 'careers', 'jobs',
  'principal', 'superintendent', 'attendance', 'nurse', 'guidance', 'registrar',
  'frontoffice', 'mainoffice', 'school', 'hs', 'ms', 'es', 'technology', 'it',
  'web', 'webteam', 'communications', 'publicrelations', 'pr', 'questions',
  'transportation', 'cafeteria', 'foodservices', 'athletics', 'welcome', 'email',
]);

/** Extract unique, non-junk email addresses from a block of text. */
export function extractEmails(text) {
  if (!text) return [];
  const found = new Set();
  EMAIL_RE.lastIndex = 0;
  let m;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    const raw = m[0].toLowerCase();
    const at = raw.indexOf('@');
    const { local } = stripEmailLabel(raw.slice(0, at));
    const email = local + raw.slice(at);
    if (isJunkEmail(email)) continue;
    found.add(email);
  }
  return [...found];
}

export function isJunkEmail(email) {
  const at = email.indexOf('@');
  if (at <= 0) return true;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain.includes('.')) return true;
  if (GENERIC_LOCAL.has(local)) return true;
  // Assets / placeholders that regex sometimes captures
  if (/\.(png|jpe?g|gif|svg|webp|css|js|json|xml)$/i.test(domain)) return true;
  if (/^(example|sentry|yourdomain|test|foo|bar|user|username|someone|person|email)\./i.test(domain)) return true;
  if (local.includes('.png') || local.includes('.jpg')) return true;
  return false;
}

// Text extractors (OpenRouter's included) sometimes glue a table label onto the
// email with no separator, e.g. "TeacherEmailmislas2@x.edu". Strip such labels.
const EMAIL_LABEL_PREFIXES = [
  'teacheremail', 'staffemail', 'emailaddress', 'e-mail', 'mailto',
  'teacher', 'staff', 'email',
];

function stripEmailLabel(local) {
  let s = local.toLowerCase();
  let stripped = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of EMAIL_LABEL_PREFIXES) {
      if (s.startsWith(p) && s.length > p.length + 1) {
        s = s.slice(p.length);
        stripped += p.length;
        changed = true;
        break;
      }
    }
  }
  return { local: s, stripped };
}

/** Return every non-junk email occurrence in a block of text, in reading order,
 *  with start/end offsets. Used to slice per-row snippets for localized analysis. */
export function emailOccurrences(text) {
  const occ = [];
  if (!text) return occ;
  EMAIL_RE.lastIndex = 0;
  let m;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    const raw = m[0].toLowerCase();
    const at = raw.indexOf('@');
    const { local, stripped } = stripEmailLabel(raw.slice(0, at));
    const email = local + raw.slice(at);
    if (isJunkEmail(email)) continue;
    occ.push({ email, start: m.index + stripped, end: m.index + m[0].length });
  }
  return occ;
}

/** Convert a CCD grade label ("KG", "PK", "UG", 9, "12") to a number, or null. */
export function gradeToNum(g) {
  if (g === null || g === undefined || g === '') return null;
  if (typeof g === 'number') return g;
  const s = String(g).trim().toUpperCase();
  if (s === 'PK' || s === 'PRE-K' || s === 'PREK' || s === 'PRESCHOOL') return -1;
  if (s === 'KG' || s === 'K' || s === 'KINDERGARTEN') return 0;
  if (s === 'UG' || s === 'UNGRADED') return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

/** Best-effort JSON object/array extraction from free-form model output. */
export function extractJson(text) {
  if (!text) return null;
  const start = text.search(/[\[{]/);
  if (start === -1) return null;
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      const open = stack.pop();
      if ((c === '}' && open !== '{') || (c === ']' && open !== '[')) return null;
      if (stack.length === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const SMALL_WORDS = new Set([
  'of', 'and', 'the', 'at', 'for', 'in', 'on', 'by', 'to', 'de', 'da', 'la', 'van',
  'von', 'del', 'di',
]);

const ACRONYMS = new Set([
  'ps', 'is', 'hs', 'ms', 'jhs', 'es', 'stem', 'ap', 'ib', 'cte', 'boces', 'nyc',
  'cs', 'esl', 'ged', 'jrotc', 'asd', 'rjr', 'k-8', 'k-12', 'pk-8', 'pk-12',
]);

const ROMAN_RE = /^[ivxlcdm]+$/i;

/** Capitalize a single word, preserving a "Mc"/"Mac" surname prefix. */
function capWord(w) {
  const lower = w.toLowerCase();
  if (/^mc[a-z]/.test(lower) && lower.length > 3) {
    return 'Mc' + lower[2].toUpperCase() + lower.slice(3);
  }
  if (/^mac[a-z]/.test(lower) && lower.length > 4) {
    return 'Mac' + lower[3].toUpperCase() + lower.slice(4);
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Handle hyphenated / slashed compounds like "Edwards-Knox" or "Junior/Senior". */
function capCompound(w) {
  return w.split(/(-|\/)/).map((part) => (/^[-/]$/.test(part) ? part : capWord(part))).join('');
}

/** Conservative title-casing for NCES's ALL-CAPS school/district names. */
export function titleCase(str) {
  if (!str) return str;
  const words = String(str).trim().split(/\s+/);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      const isLast = i === words.length - 1;
      if (ROMAN_RE.test(w) && /^[ivxlcdm]+$/.test(w)) return w.toUpperCase();
      if (ACRONYMS.has(lower)) return w.toUpperCase();
      if (lower === 'jr' || lower === 'sr') return lower.charAt(0).toUpperCase() + lower.slice(1);
      if (w.length === 1) return w.toUpperCase(); // middle initial "A", "J", etc.
      if (w.includes('-') || w.includes('/')) return capCompound(w);
      if (!isLast && SMALL_WORDS.has(lower)) return lower;
      return capWord(w);
    })
    .join(' ');
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'x';
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  // Atomic write (temp + rename) so a crash mid-write can never corrupt a
  // cached result into partial JSON.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
