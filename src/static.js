import { emailOccurrences } from './utils.js';

// ---------------------------------------------------------------------------
// Static (regex / keyword) analysis. This runs first and is free.
// The AI pass in discovery.js refines names/roles that regex gets wrong.
// ---------------------------------------------------------------------------

const CS_TERM_RE =
  /(computer\s*science|AP\s*CS\b|AP\s*Computer|computer\s*programming|coding|computer\s*club|CS\s*club|coding\s*club|robotics|cyber\s*security|cybersecurity|AP\s*CSP|AP\s*CSA|software\s*engineering|web\s*development|web\s*design|game\s*design)/i;

const TITLE_RE =
  /(teacher|instructor|educator|advisor|adviser|coach|faculty|sponsor|mentor|department\s*(chair|head|lead)|dept\s*(chair|head|lead)|curriculum\s*(lead|coordinator|supervisor)|instructional\s*coach|lead|coordinator|director|specialist|professor|lecturer|dean)/i;

// Names look like "Jane Smith", "J. Smith", "Jane A. Smith" (2-3 tokens).
const NAME_RE = /\b([A-Z][a-z]{2,}(?:\s+(?:[A-Z]\.|[A-Z][a-z]{1,})){1,2})\b/g;

const NAME_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'contact', 'home', 'about', 'school',
  'high', 'middle', 'junior', 'senior', 'teacher', 'staff', 'faculty', 'department',
  'dept', 'phone', 'email', 'address', 'district', 'our', 'welcome', 'please',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'computer', 'science',
  'technology', 'welcome', 'homepage', 'search', 'links', 'clubs', 'activities',
  'athletics', 'program', 'course', 'courses', 'class', 'classes', 'ap', 'honors',
  'directory', 'staff', 'faculty', 'team', 'contact', 'home', 'page', 'portal',
]);

export function isCSRelated(text) {
  return CS_TERM_RE.test(text || '');
}

/** Guess a readable role label from a block of text. */
export function roleFromText(text) {
  const t = text || '';
  const hasCS = CS_TERM_RE.test(t);
  const hasAdvisor = /(advisor|adviser|coach|sponsor|club)/i.test(t);
  const hasChair = /department\s*(chair|head|lead)|dept\s*(chair|head|lead)|curriculum\s*(lead|coordinator|supervisor)/i.test(t);
  const hasLead = /(lead|coordinator|director|specialist|instructional\s*coach)/i.test(t);
  const hasTeacher = /(teacher|instructor|educator|faculty|professor|lecturer)/i.test(t);

  if (hasCS && hasAdvisor) return 'Computer Science Club Advisor';
  if (hasCS && hasChair) return 'Computer Science Department Lead';
  if (hasCS && hasLead) return 'Computer Science Lead';
  if (hasCS && hasTeacher) return 'Computer Science Teacher';
  if (hasCS) return 'Computer Science Teacher';
  return null;
}

function findNameNear(text, emailIndex, before = 220) {
  const start = Math.max(0, emailIndex - before);
  const window = text.slice(start, emailIndex);
  const matches = [...window.matchAll(NAME_RE)];
  if (!matches.length) return null;
  const name = matches[matches.length - 1][0].trim();
  const tokens = name.split(/\s+/);
  if (tokens.length > 3) return null;
  if (tokens.some((t) => NAME_STOPWORDS.has(t.toLowerCase().replace('.', '')))) return null;
  return name;
}

/**
 * Extract focused (email, snippet, url) tuples: for every email on the page,
 * capture the surrounding text (the "row" the email sits in). This localizes
 * downstream AI extraction so it reads one staff row at a time instead of a
 * whole directory.
 */
export function emailSnippets(text, url) {
  if (!text) return [];
  const occs = emailOccurrences(text);
  const seen = new Set();
  const out = [];
  for (let i = 0; i < occs.length; i++) {
    const occ = occs[i];
    const prevEnd = i > 0 ? occs[i - 1].end : 0;
    // Staff directories are almost always "Name Title email": the person's info
    // precedes their email. Slice from just after the previous email up to THIS
    // email (no lookahead), so each snippet is exactly one person's row.
    const winStart = Math.max(prevEnd, occ.start - 300);
    const winEnd = occ.end;
    if (seen.has(occ.email)) continue;
    seen.add(occ.email);
    const snippet = text.slice(winStart, winEnd).replace(/\s+/g, ' ').trim();
    out.push({ email: occ.email, snippet, url });
  }
  return out;
}

/**
 * Produce best-effort CS-person candidates from a block of page text.
 * Each candidate has: name?, role?, email, evidence, snippet.
 * Built on the same bounded per-row snippets as the AI pass, so a row is only
 * flagged if its OWN text mentions computer science.
 */
export function staticCandidates(text, sourceUrl) {
  if (!text) return [];
  const out = [];
  const seen = new Set();

  for (const { email, snippet } of emailSnippets(text, sourceUrl)) {
    if (!isCSRelated(snippet)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    const role = roleFromText(snippet);
    const idx = snippet.toLowerCase().indexOf(email);
    const name = idx >= 0 ? findNameNear(snippet, idx, 200) : null;

    out.push({
      name: name || undefined,
      role: role || undefined,
      email,
      evidence: sourceUrl,
      snippet: snippet.slice(0, 400),
    });
  }
  return out;
}
