import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  STATES,
  SCHOOLS_FILE,
  OUTPUT_FILE,
  MAP_DATA_FILE,
  CACHE_DIR,
  HC_API_KEY,
  LLM_PROVIDER,
  OPENROUTER_API_KEY,
  SEARCH_PROVIDER,
  CONCURRENCY,
  REQUEST_DELAY_MS,
} from './config.js';
import { readJson, writeJson, ensureDir, sleep } from './utils.js';
import { discoverSchool, verifyAIConnection } from './discovery.js';
import { main as fetchSchools } from './fetchSchools.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    states: STATES,
    limit: 0,
    only: null,
    staticOnly: false,
    includeEmpty: false,
    retryErrors: false,
    verify: false,
    sample: 0,
    buildOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--state':
        opts.states = next().split(',').map((s) => s.trim().toUpperCase());
        break;
      case '--limit':
        opts.limit = Number(next());
        break;
      case '--sample':
        opts.sample = Number(next());
        break;
      case '--only':
        opts.only = next();
        break;
      case '--static-only':
        opts.staticOnly = true;
        break;
      case '--include-empty':
        opts.includeEmpty = true;
        break;
      case '--retry-errors':
        opts.retryErrors = true;
        break;
      case '--verify':
        opts.verify = true;
        break;
      case '--build-only':
        opts.buildOnly = true;
        break;
      default:
        break;
    }
  }
  return opts;
}

function cacheFile(id) {
  return path.join(CACHE_DIR, `${id}.json`);
}

async function processSchool(school, opts, state) {
  const file = cacheFile(school.ncessch);
  const cached = readJson(file, null);

  if (cached && cached.status !== 'error') {
    state.cached++;
    return cached;
  }
  if (cached && cached.status === 'error' && !opts.retryErrors) {
    state.skippedErrors++;
    return cached;
  }

  state.processed++;
  const result = await discoverSchool(school, { ai: !opts.staticOnly });
  writeJson(file, result);
  if (result.csPeople.length) state.withPeople++;
  return result;
}

async function runPool(items, worker, concurrency, onProgress) {
  let next = 0;
  let done = 0;
  let fatal = null;

  async function run() {
    while (true) {
      if (fatal) return;
      const idx = next++;
      if (idx >= items.length) return;
      try {
        const res = await worker(items[idx]);
        if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
        done++;
        onProgress?.(done, items.length, items[idx], res);
      } catch (e) {
        if (e?.code === 'SPEND_LIMIT' || e?.code === 'AUTH') {
          fatal = e;
          return;
        }
        // Non-fatal: record an error entry so resume doesn't infinite-loop.
        writeJson(cacheFile(items[idx].ncessch), {
          id: items[idx].ncessch,
          schoolName: items[idx].schoolName,
          status: 'error',
          error: String(e?.message || e).slice(0, 500),
          csPeople: [],
        });
        done++;
        onProgress?.(done, items.length, items[idx], null, e);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, run));
  return fatal;
}

/** Build output from EVERY cached school (matching state filter), so re-runs
 *  with different --sample/--limit selections still aggregate prior results. */
function buildOutput(states, includeEmpty) {
  const out = [];
  if (!fs.existsSync(CACHE_DIR)) return out;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    if (!file.endsWith('.json')) continue;
    const c = readJson(path.join(CACHE_DIR, file), null);
    if (!c || !Array.isArray(c.csPeople)) continue;
    if (!states.includes(c.state)) continue;
    if (c.status === 'error') continue;
    if (!c.csPeople.length && !includeEmpty) continue;
    out.push({
      id: c.id,
      schoolName: c.schoolName,
      district: c.district,
      state: c.state,
      city: c.city,
      lat: c.lat,
      long: c.long,
      csPeople: c.csPeople.map((p) => ({
        name: p.name,
        role: p.role,
        email: p.email,
        ...(p.evidence ? { evidence: p.evidence } : {}),
      })),
    });
  }
  out.sort((a, b) => String(a.schoolName).localeCompare(String(b.schoolName)));
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv = []) {
  const opts = parseArgs(argv);

  if (opts.verify) {
    console.log(`Verifying LLM connection + model (provider: ${LLM_PROVIDER})...`);
    const res = await verifyAIConnection();
    console.log('OK ->', JSON.stringify(res));
    return;
  }

  // Validate the keys the active providers actually need.
  const searchUsesOpenrouter =
    SEARCH_PROVIDER === 'openrouter' || (SEARCH_PROVIDER === 'auto' && !!OPENROUTER_API_KEY);
  const missing = [];
  if (searchUsesOpenrouter && !OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY (web search)');
  if (!searchUsesOpenrouter && !HC_API_KEY) missing.push('HACK_CLUB_AI_API_KEY (Exa web search)');
  if (LLM_PROVIDER === 'openrouter' && !OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY (LLM)');
  if (LLM_PROVIDER === 'hackclub' && !HC_API_KEY) missing.push('HACK_CLUB_AI_API_KEY (LLM)');

  if (missing.length) {
    console.error(
      'Missing required API key(s): ' + missing.join(', ') + '.\n' +
        'Add them to .env (see .env.example), then re-run: node src/index.js',
    );
    process.exitCode = 1;
    return;
  }

  // 1. School list
  let schools = readJson(SCHOOLS_FILE, null);
  if (!schools) {
    console.log('No data/schools.json found — fetching the public-school list now...');
    schools = await fetchSchools({ states: opts.states });
  }

  // 2. Filters
  let targets = schools.filter((s) => opts.states.includes(s.state));
  if (opts.only) targets = targets.filter((s) => s.ncessch === opts.only || s.schoolName.toLowerCase().includes(opts.only.toLowerCase()));
  if (opts.sample > 0) {
    const shuffled = [...targets].sort(() => Math.random() - 0.5);
    targets = shuffled.slice(0, opts.sample);
  }
  if (opts.limit > 0) targets = targets.slice(0, opts.limit);

  console.log(
    `Target: ${targets.length} school(s) in [${opts.states.join(', ')}] ` +
      `(AI ${opts.staticOnly ? 'OFF' : 'ON'}, concurrency ${CONCURRENCY})`,
  );

  // 3. Process (resumable). Skipped entirely with --build-only (no budget used).
  ensureDir(CACHE_DIR);

  // Report resume state so a restart is transparent (nothing gets reprocessed).
  const resumeState = targets.reduce(
    (acc, s) => {
      const c = readJson(cacheFile(s.ncessch), null);
      if (c && c.status !== 'error') {
        acc.cached++;
        if (c.csPeople && c.csPeople.length) acc.withPeople++;
      } else if (c && c.status === 'error') {
        acc.errors++;
      }
      return acc;
    },
    { cached: 0, withPeople: 0, errors: 0 },
  );
  console.log(
    `Resume state: ${resumeState.cached} cached (${resumeState.withPeople} with people), ` +
      `${resumeState.errors} cached-errors, ${targets.length - resumeState.cached - resumeState.errors} remaining`,
  );

  let fatal = null;
  if (!opts.buildOnly) {
    const state = { cached: 0, processed: 0, skippedErrors: 0, withPeople: 0 };

    fatal = await runPool(
      targets,
      (s) => processSchool(s, opts, state),
      CONCURRENCY,
      (d, total) => {
        if (d % 10 === 0 || d === total) {
          console.log(
            `  progress ${d}/${total} | cached ${state.cached} | processed ${state.processed} | with-people ${state.withPeople}`,
          );
        }
      },
    );
  }

  // 4. Build output from cache
  const out = buildOutput(opts.states, opts.includeEmpty);
  writeJson(OUTPUT_FILE, out);
  writeJson(MAP_DATA_FILE, out);

  const totalPeople = out.reduce((n, s) => n + s.csPeople.length, 0);
  const withPeople = out.filter((s) => s.csPeople.length).length;
  console.log('\n==============================');
  console.log(`Schools with CS people : ${withPeople}`);
  console.log(`Total CS people found   : ${totalPeople}`);
  console.log(`Wrote data/cs_people.json and map/data/cs_people.json`);
  console.log('==============================');

  if (fatal) {
    console.warn('\nStopped early:', fatal.message);
    console.warn('Progress is saved. Re-run the same command later to resume (it skips cached schools).');
    process.exitCode = 0;
  }

  console.log(`\nTo view the map, run:  npm run map  then open http://localhost:8080`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
