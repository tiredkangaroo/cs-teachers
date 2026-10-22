# CS Teachers & Advisors — Tristate Finder

A tool that finds **computer science people** (CS/AP-CS teachers, CS club
advisors, coding/robotics coaches, CS & CTE department leads) at **public high
schools** in the **NY / NJ / CT tristate area**, and visualizes them on an
interactive map.

It combines:

1. **Static analysis first** — the public-school directory (name, lat/long) is
   pulled from the free [Urban Institute Education Data Portal](https://educationdata.urban.org),
   and page text is scanned with regex/keyword heuristics for CS roles and
   emails.
2. **AI for non-static analysis** — [Hack Club AI](https://docs.ai.hackclub.com)
   (Exa web search + an LLM) is used to find the right staff-directory /
   department pages and to structure names, roles, and emails that regex can't
   reliably parse.

## Output

`data/cs_people.json` (and a copy at `map/data/cs_people.json`):

```json
[
  {
    "id": "360000104498",
    "schoolName": "James A Green Junior-Senior High School",
    "district": "Dolgeville Central School District",
    "state": "NY",
    "city": "Dolgeville",
    "lat": 43.104,
    "long": -74.779,
    "csPeople": [
      {
        "name": "Jane Smith",
        "role": "Teacher of AP Computer Science A",
        "email": "jsmith@example.org",
        "evidence": "https://example.org/staff/jsmith"
      }
    ]
  }
]
```

`id`, `district`, `state`, and `city` are additive enrichment fields on top of
the requested schema (`schoolName`, `lat`, `long`, `csPeople`).

## Setup

```bash
# 1. Add an OpenRouter API key (https://openrouter.ai/keys).
#    OpenRouter handles BOTH web search (discovery) and the LLM, so no other
#    key is strictly required.
cp .env.example .env
#    edit .env: set OPENROUTER_API_KEY=sk-or-v1-... (LLM_PROVIDER defaults to openrouter)

# 2. Fetch the school list (no key needed)
npm run schools

# 3. Find CS people (uses OpenRouter; resumable)
npm run find

# 4. Open the map
npm run map
#    then visit http://localhost:8080
```

### Provider options

| Concern | Default | Alternatives |
| --- | --- | --- |
| Web search (discovery) | OpenRouter `:online` search | `SEARCH_PROVIDER=exa` → Hack Club AI Exa (needs `HACK_CLUB_AI_API_KEY`) |
| LLM (extraction) | OpenRouter | `LLM_PROVIDER=hackclub` → Hack Club AI (needs `HACK_CLUB_AI_API_KEY`) |

Set `SEARCH_PROVIDER=auto` (the default) and the tool uses OpenRouter search
whenever an `OPENROUTER_API_KEY` is present, otherwise it falls back to Exa.

## Commands

| Command | What it does |
| --- | --- |
| `npm run schools` | Download + filter the public-school list to `data/schools.json`. |
| `npm run find` | Discover CS people for every target school, writing `data/cs_people.json`. |
| `npm run map` | Serve the interactive map locally on `:8080`. |

### `npm run find` options

```
node src/index.js [--state NY,NJ,CT] [--limit N] [--sample N] [--only <id|name>]
                  [--static-only] [--include-empty] [--retry-errors] [--verify]
```

- `--state NY,NJ,CT` — restrict to specific states.
- `--limit N` — only process the first N schools (useful for testing).
- `--sample N` — process a random sample of N schools.
- `--only <id|name>` — process a single school (matches NCES id or name).
- `--static-only` — skip the LLM step (regex + Exa search only). Cheaper, lower fidelity.
- `--include-empty` — also write schools where no CS people were found.
- `--retry-errors` — re-attempt schools previously cached with an error.
- `--verify` — check that the API key + model work.
- `--build-only` — skip discovery; just rebuild `cs_people.json` + map data from
  the cache (no budget spent).

### Test a small run before the full crawl

```bash
node src/index.js --sample 25          # 25 random schools
node src/index.js --state NJ --limit 20
```

## How discovery works (per school)

1. **Web search** for the school + "computer science teacher / club advisor",
   returning page text inline (OpenRouter `:online`, or Exa). If no CS-relevant
   rows are found, a second, staff-directory-focused query runs.
2. **Static pass** — each email on the page is sliced into a *bounded snippet*
   (the single staff row it sits in), and rows whose own text mentions CS are
   flagged. This localization is what keeps names/titles from bleeding across
   people.
3. **AI pass** — one LLM call over *only those CS-relevant row snippets* returns
   a structured `{people:[{email,name,role}]}`, which is merged with (and
   validated against) the static emails.
4. **Validation** — deterministic post-checks discard non-person names
   (school/street/department/heading), roles that don't mention CS, and
   name↔email pairings that don't appear together on the page. This is what
   prevents the model from hallucinating "Computer Science Teacher" for a
   principal or a parent coordinator.
5. **Cache** — every school's result is written to `data/cache/<ncessch>.json`,
   so runs are resumable.

Precision is deliberately favored over recall: the tool only emits a person when
it can tie a real name, a CS role, and an email together on one page. Schools
that don't publish that information (or only behind JS / images) are reported
as empty rather than guessed.

## Important notes

- **Rate & credit limits.** Both OpenRouter (credit) and Hack Club AI (`$3/day`)
  enforce limits. The tool caches every school and resumes where it left off, so
  a full crawl can be spread across as many sessions as needed by re-running
  `npm run find`. When a limit is hit (HTTP 402), it stops gracefully and saves
  progress; hitting `--build-only` later rebuilds the map data from cache for free.
- **OpenRouter web search can be rate-limited.** `:online` search requests are
  heavier than plain LLM calls, so under concurrency the run can slow down (the
  tool backs off and retries on 429). If it feels slow, lower `CONCURRENCY` in
  `.env`.
- **Responsible use.** This collects *school-published* professional contact
  information (staff directory emails). Use it for legitimate CS-education
  outreach. Respect `robots.txt`, keep rates modest, and remove anyone who
  asks to be excluded.
- **Data quality.** Precision is favored over recall, so expect some schools to
  be reported empty when their CS staff aren't clearly listed. Some schools
  don't publish staff emails or CS pages, and web results can be stale. Always
  treat the `evidence` URL as the source of truth and verify before outreach.

## Project layout

```
src/
  fetchSchools.js   # Urban Institute public-school directory -> data/schools.json
  discovery.js      # per-school Exa search + static + AI extraction
  static.js         # regex/keyword heuristics (free)
  ai.js             # Hack Club AI chat + Exa proxy helpers
  index.js          # orchestrator (queue, resume, caching, output)
  utils.js          # http, html->text, email, json helpers
  config.js         # constants & env
map/                # Leaflet interactive map (static site)
data/               # generated output (gitignored)
```
