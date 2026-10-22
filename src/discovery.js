import { webSearch, chatJson } from './ai.js';
import { staticCandidates, isCSRelated, emailSnippets } from './static.js';
import { extractEmails, titleCase } from './utils.js';

const MAX_SNIPPETS = 40;

function buildQuery(school) {
  return `Find web pages that list the computer science teacher, computer science club advisor, or computer science department at ${school.schoolName} in ${school.city}, ${school.state}. Prioritize the school's own staff directory and computer science / technology department pages.`;
}

function buildFallbackQuery(school) {
  return `Find the staff directory page for ${school.schoolName} (${school.district}) that lists teachers, their departments, and email addresses, especially computer science.`;
}

// The AI sees individual, localized rows (one email + its surrounding text),
// not whole directories. This prevents cross-row name "chaining" and stops it
// from labeling unrelated staff as CS.
const SYSTEM_PROMPT = `You are given a list of staff entries, one per line, each shaped like:
EMAIL <email> | <snippet>

The snippet is the text immediately around one staff member's email on a school website — usually their name and job title on the same row.

For each entry, extract the person's full name and job title IF AND ONLY IF they teach or lead computer science (computer science / CS teacher, AP Computer Science A or Principles, computer programming, coding, software, game design, robotics, cybersecurity, CS club advisor/sponsor, CS/CTE department chair or lead).

Return STRICT JSON only, exactly:
{"people":[{"email":"","name":"","role":""}]}

Rules — PRECISION OVER RECALL; when uncertain, OMIT the person:
- "email": copy it exactly from the entry.
- "name": the individual's real name (typically 2-3 words). It is the PERSON's name in the snippet — never a school/building/street/department/heading name, and never a job title. Do NOT include "Teacher", "Occupational Therapist", "Coordinator", etc. as part of the name.
- "role": the person's actual POSITION/JOB TITLE as printed in the snippet (e.g. the text right after "Position", "Title", or "Role"). It MUST mention computer science (or CS / programming / coding / robotics / software) — otherwise do not include the person. Do NOT infer a CS title from their biography, qualifications, or interests; if their position says "Art Teacher" (even if their bio mentions computer science), exclude them.
- Only include people whose snippet clearly ties them to computer science.
- If no entry is a computer science person, return {"people":[]}.`;

async function aiExtract(school, snippets) {
  const lines = snippets
    .slice(0, MAX_SNIPPETS)
    .map((s) => `EMAIL ${s.email} | ${s.snippet.slice(0, 320)}`)
    .join('\n');
  const res = await chatJson(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `School: ${school.schoolName}\n\n${lines}` },
    ],
    { maxTokens: 2000 },
  );
  const people = Array.isArray(res?.people) ? res.people : [];
  return people
    .map((p) => ({
      name: (p?.name || '').toString().trim(),
      role: (p?.role || '').toString().trim(),
      email: (p?.email || '').toString().trim().toLowerCase(),
    }))
    .filter((p) => p.name && p.email);
}

/** Map email -> page URL by locating the email in each page's text. */
function emailToUrl(pages, email) {
  for (const p of pages) {
    if (p.text && p.text.toLowerCase().includes(email)) return p.url;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Post-validation: the LLM is good but over-inclusive. These cheap, deterministic
// checks discard school/address/department names, non-CS roles, and name-email
// mis-associations before anything is written to disk.
// ---------------------------------------------------------------------------

const NAME_BAN = new Set([
  'elementary', 'middle', 'junior', 'senior', 'high', 'school', 'schools',
  'academy', 'institute', 'university', 'college', 'district', 'street', 'avenue',
  'road', 'drive', 'lane', 'boulevard', 'place', 'court', 'highway', 'parkway',
  'coordinator', 'bullying', 'information', 'instructor', 'teacher', 'principal',
  'superintendent', 'counselor', 'athletics', 'athletic', 'director', 'coach',
  'advisor', 'adviser', 'club', 'department', 'dept', 'faculty', 'staff',
  'building', 'campus', 'center', 'office', 'phone', 'fax', 'email', 'home',
  'page', 'portal', 'assistant', 'associate', 'supervisor', 'specialist',
  'secretary', 'nurse', 'librarian', 'administrator', 'administration',
  'registrar', 'chairperson', 'chair', 'lead', 'president', 'vice', 'honors',
  'team', 'group', 'parent', 'student', 'students', 'welcome', 'contact', 'about',
  'news', 'events', 'calendar', 'resources', 'links', 'quick', 'search', 'menu',
  'main', 'north', 'south', 'east', 'west', 'central', 'union', 'free', 'city',
  'county', 'ap', 'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr',
  // places / entities / titles that are never part of a personal name
  'state', 'archives', 'education', 'higher', 'history', 'records', 'library',
  'museum', 'grant', 'program', 'award', 'scholarship', 'foundation',
  'association', 'society', 'commission', 'national', 'cyber', 'coding',
  'tomorrow', 'computer', 'science', 'mathematics', 'math', 'technology',
  'engineering', 'robotics', 'innovation', 'learning', 'academic', 'career',
  'advanced', 'placement', 'lower', 'upper', 'house', 'houses', 'terrace',
  'view', 'floor', 'wing', 'annex', 'room',
  'head', 'moderator', 'sponsor', 'facilitator', 'liaison', 'leader',
  'paraprofessional', 'therapist', 'psychologist', 'occupational', 'aide',
  // road / company suffixes
  'rd', 'ave', 'blvd', 'ln', 'ct', 'hwy', 'pky', 'pkwy', 'pl', 'llc', 'inc',
  'ltd', 'corp', 'org', 'pta', 'pto', 'boe',
]);

const BAD_FULL_NAMES = new Set([
  'new york', 'new york state', 'new york city', 'new jersey', 'united states',
  'higher education', 'computer science', 'science department', 'national cyber',
  'the arts', 'law public', 'service',
]);

/** Return a clean personal name, or null if it's clearly not a person. */
function sanitizeName(name) {
  if (!name) return null;
  const clean = String(name).replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 45) return null;
  const tokens = clean
    .split(' ')
    .map((t) => t.replace(/[^A-Za-z'.-]/g, ''))
    .filter((t) => t.length > 0);
  const kept = tokens.filter((t) => {
    const w = t.replace(/[^A-Za-z]/g, '').toLowerCase();
    return w && w.length > 1 && !NAME_BAN.has(w);
  });
  if (kept.length < 2 || kept.length > 4) return null;
  let joined = kept.join(' ');
  if (BAD_FULL_NAMES.has(joined.toLowerCase())) return null;
  // Normalize ALL-CAPS names (common in directories) to title case.
  if (joined === joined.toUpperCase()) joined = titleCase(joined);
  return joined;
}

/** Does the person's name actually appear next to their email on the page? */
function emailNearName(pageText, name, email) {
  const t = (pageText || '').toLowerCase();
  const e = String(email).toLowerCase();
  const ei = t.indexOf(e);
  if (ei === -1) return false;
  const window = t.slice(Math.max(0, ei - 300), ei + e.length + 80);
  const nameTokens = name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return nameTokens.some((tok) => window.includes(tok));
}

function verifyAssociation(p, pages) {
  // The email must actually appear in one of the captured pages; otherwise the
  // model hallucinated or mangled it.
  const page = pages.find((pg) => pg.text && pg.text.toLowerCase().includes(p.email));
  if (!page) return false;
  return emailNearName(page.text, p.name, p.email);
}

/**
 * Discover CS people for a single school.
 * Static regex analysis runs first (free); AI structures the result.
 */
export async function discoverSchool(school, opts = {}) {
  const useAI = opts.ai !== false;
  const numResults = opts.numResults || 4;

  // ---- Discovery: primary Exa search, with a targeted fallback when the
  // primary results contain no CS-relevant staff rows. ----
  const pageMap = new Map();
  const addResults = (rs) => {
    for (const r of rs || []) {
      if (r.url && !pageMap.has(r.url)) pageMap.set(r.url, { url: r.url, title: r.title || '', text: r.text || '' });
    }
  };

  let results = [];
  try {
    results = await webSearch(buildQuery(school), { numResults });
  } catch (e) {
    if (e?.code === 'SPEND_LIMIT' || e?.code === 'AUTH') throw e;
  }
  addResults(results);

  const hasCS = [...pageMap.values()].some((p) => emailSnippets(p.text, p.url).some((s) => isCSRelated(s.snippet)));
  if (!hasCS) {
    try {
      addResults(await webSearch(buildFallbackQuery(school), { numResults: 3 }));
    } catch (e) {
      if (e?.code === 'SPEND_LIMIT' || e?.code === 'AUTH') throw e;
    }
  }

  const pages = [...pageMap.values()];
  const sources = pages.map((p) => p.url);

  // ---- Static pass (always): one focused snippet per email (the "row"). ----
  const snippets = [];
  for (const p of pages) {
    snippets.push(...emailSnippets(p.text, p.url));
  }
  const emailToUrlMap = new Map(snippets.map((s) => [s.email, s.url]));

  // Only rows whose local text actually mentions computer science.
  const csSnippets = snippets.filter((s) => isCSRelated(s.snippet));

  // Static name/role guesses (free; looser than AI, used as fallback + for --static-only).
  const staticPeople = [];
  for (const p of pages) {
    staticPeople.push(...staticCandidates(p.text, p.url));
  }

  // ---- AI pass (optional): structure CS-relevant rows only. ----
  let aiPeople = [];
  if (useAI && csSnippets.length) {
    try {
      aiPeople = await aiExtract(school, csSnippets);
    } catch (e) {
      if (e?.code === 'SPEND_LIMIT' || e?.code === 'AUTH') throw e;
      aiPeople = []; // fall back to static results
    }
  }

  // Merge: AI first (higher fidelity), then static-only emails AI missed.
  const byEmail = new Map();
  for (const p of aiPeople) {
    byEmail.set(p.email, {
      ...p,
      evidence: emailToUrlMap.get(p.email) || sources[0] || '',
    });
  }
  for (const p of staticPeople) {
    const key = p.email || `name:${p.name}`;
    if (key && !byEmail.has(key)) {
      byEmail.set(key, { ...p, evidence: p.evidence || emailToUrlMap.get(p.email) || sources[0] || '' });
    }
  }

  const csPeople = [...byEmail.values()]
    .map((p) => {
      const email = (p.email || '').toLowerCase();
      const name = sanitizeName(p.name);
      const role = p.role || undefined;
      const evidence = p.evidence || emailToUrl(pages, email) || sources[0] || '';
      return { name, role, email, evidence };
    })
    // Precision filters:
    .filter((p) => p.name && p.email)               // must have a person + email
    .filter((p) => p.role && isCSRelated(p.role))   // role must be computer science
    .filter((p) => verifyAssociation(p, pages))     // email must belong to the name
    .map((p) => {
      const o = { name: p.name, role: p.role, email: p.email };
      if (p.evidence) o.evidence = p.evidence;
      return o;
    });

  // Dedupe identical name+email.
  const unique = [];
  const seenKey = new Set();
  for (const p of csPeople) {
    const key = `${p.name}|${p.email}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    unique.push(p);
  }

  return {
    id: school.ncessch,
    schoolName: school.schoolName,
    district: school.district,
    state: school.state,
    city: school.city,
    lat: school.lat,
    long: school.long,
    csPeople: unique,
    sources,
    staticCount: staticPeople.length,
    aiCount: aiPeople.length,
    status: unique.length ? 'ok' : csSnippets.length ? 'no-match' : 'empty',
    searchedAt: new Date().toISOString(),
  };
}

/** For debugging: verify the key + model work with a tiny request. */
export async function verifyAIConnection() {
  const emails = extractEmails('test@example.com');
  void emails;
  const res = await chatJson(
    [
      { role: 'system', content: 'Return strict JSON: {"ok":true}' },
      { role: 'user', content: 'hi' },
    ],
    { maxTokens: 300 },
  );
  return res;
}
