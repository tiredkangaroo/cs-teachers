import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATES, CCD_YEAR, SCHOOLS_FILE } from './config.js';
import { httpJson, writeJson, gradeToNum, titleCase } from './utils.js';

const BASE = 'https://educationdata.urban.org/api/v1/schools/ccd/directory';

/**
 * Pull the full public-school directory for one state from the Urban
 * Institute Education Data Portal (free, no key) and page through results.
 */
export async function fetchStateSchools(state) {
  const all = [];
  let url = `${BASE}/${CCD_YEAR}/?state_location=${state}&page=1&size=2000`;
  while (url) {
    const data = await httpJson(url);
    all.push(...(data?.results || []));
    url = data?.next || null;
  }
  return all;
}

/** A school is in scope if it's an operating public school that serves grades 9+. */
function isTarget(s) {
  if (!s) return false;
  if (s.school_status === 2 || s.school_status === 8) return false; // closed / inactive
  if (s.virtual === 1) return false; // fully virtual schools
  const hi = gradeToNum(s.highest_grade_offered);
  return hi !== null && hi >= 9;
}

function trim(s) {
  return {
    ncessch: s.ncessch,
    schoolName: titleCase(s.school_name),
    district: titleCase(s.lea_name),
    state: s.state_location,
    city: titleCase(s.city_location),
    lat: s.latitude,
    long: s.longitude,
    phone: s.phone,
    charter: s.charter === 1,
    lowestGrade: s.lowest_grade_offered,
    highestGrade: s.highest_grade_offered,
    enrollment: s.enrollment,
  };
}

export async function main({ states = STATES } = {}) {
  const out = [];
  for (const st of states) {
    const schools = await fetchStateSchools(st);
    const targets = schools.filter(isTarget).map(trim);
    out.push(...targets);
    console.log(`${st}: ${targets.length} target schools (of ${schools.length} total)`);
  }
  writeJson(SCHOOLS_FILE, out);
  console.log(`\nWrote ${out.length} schools to ${SCHOOLS_FILE}`);
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2).map((a) => a.toUpperCase());
  const states = args.length ? args : STATES;
  main({ states }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
