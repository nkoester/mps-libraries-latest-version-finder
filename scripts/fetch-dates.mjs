#!/usr/bin/env node
/**
 * Records when each version was published to the repository. Run after
 * fetch-versions.mjs; writes:
 *
 *   data/dates/<slug>.json     version -> UTC timestamp, e.g. 2026-09-17T13:35:08Z
 *                              (null = repository has no date)
 *
 * and copies the dates into versions.json and data/<slug>.json.
 *
 * The timestamp is the upload time on artifacts.itemis.cloud, not the upstream
 * release time: versions migrated to this Nexus in mid-2022 all carry their
 * migration date, and mirrored MPS builds carry the date they were mirrored.
 *
 * Sources:
 *   - releases: the Nexus search API, `lastModified` of the POM asset. A
 *     library with many undated versions is swept page by page (50 per
 *     request); a few new ones are looked up one by one.
 *   - SNAPSHOTs are not in the search index, so their own
 *     maven-metadata.xml is read for `<lastUpdated>`.
 *
 * Nexus is the ground truth, but a regular run only looks up versions not
 * cached yet; a sweep then fills only those. Two opt-in refreshes replace
 * cached values with whatever Nexus returns now:
 *   --snapshots  re-read every cached SNAPSHOT (a redeploy changes its time);
 *                CI passes it once a day.
 *   --full       re-sweep every library, refreshing all release dates.
 *                Local only, never in CI.
 * A value Nexus no longer reports is kept. Entries cached as a bare
 * YYYY-MM-DD (before times were kept) are looked up again. A version the
 * repository does not know yet is retried on later runs and only recorded
 * as null after NOT_FOUND_TRIES runs spanning NOT_FOUND_GRACE_MS.
 *
 * Each run makes at most --max lookups of uncached versions (default 400);
 * sweeps and SNAPSHOT re-reads are not counted.
 *
 * Usage: node scripts/fetch-dates.mjs [--max <n>] [--snapshots] [--full]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactUrls, compareVersions, isMarker, isSnapshot } from '../versions-lib.js';
import { applyDates, datesPath, readDates } from './dates-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_URL = 'https://artifacts.itemis.cloud/service/rest/v1/search';
const REPOSITORY = 'maven-mps';

const CONCURRENCY = 8;
const TIMEOUT_MS = 30000;
const ATTEMPTS = 3;
const DEFAULT_MAX = 400;
/** More undated releases than this and a full sweep is cheaper. */
const SWEEP_THRESHOLD = 25;
const NOT_FOUND_TRIES = 3;
const NOT_FOUND_GRACE_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const index = argv.indexOf('--max');
  const max = index === -1 ? DEFAULT_MAX : Number(argv[index + 1]);
  if (!Number.isInteger(max) || max < 0) throw new Error(`--max needs a non-negative integer, got "${argv[index + 1]}"`);
  return { max, full: argv.includes('--full'), snapshots: argv.includes('--snapshots') };
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeIfChanged(path, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (existsSync(path) && (await readFile(path, 'utf8')) === text) return false;
  await writeFile(path, text);
  return true;
}

/** Response, null on 404, throws on anything else after retries. */
async function fetchWithRetry(url, read) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await read(response);
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}

async function pool(items, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

/** A cache value from before times were kept: YYYY-MM-DD only. */
const isDateOnly = (value) => typeof value === 'string' && value.length === 10;

/** UTC timestamp at second precision, e.g. 2026-09-17T13:35:08Z; null if unparseable. */
function toTimestamp(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Upload time of one search-API component: its POM, else its oldest asset. */
function componentDate(component) {
  const assets = component.assets ?? [];
  const pom = assets.find((asset) => asset.maven2?.extension === 'pom' && !asset.maven2?.classifier);
  const stamps = (pom ? [pom] : assets)
    .map((asset) => asset.lastModified && toTimestamp(asset.lastModified))
    .filter(Boolean)
    .sort();
  return stamps[0] ?? null;
}

function searchUrl(library, params = {}) {
  const query = new URLSearchParams({
    repository: REPOSITORY,
    group: library.groupId,
    name: library.artifactId,
    ...params,
  });
  return `${SEARCH_URL}?${query}`;
}

/** Every component of a library the search index knows: version -> timestamp. */
async function sweep(library) {
  const found = {};
  let token = null;
  do {
    const page = await fetchWithRetry(
      searchUrl(library, token ? { continuationToken: token } : {}),
      (response) => response.json(),
    );
    for (const component of page?.items ?? []) {
      const date = componentDate(component);
      if (date) found[component.version] = date;
    }
    token = page?.continuationToken ?? null;
  } while (token);
  return found;
}

/** Upload time of one version, null if the repository does not know it (yet). */
async function lookup(library, version) {
  if (isSnapshot(version)) {
    const metadata = await fetchWithRetry(artifactUrls(library, version).versionMetadata, (r) => r.text());
    // Maven writes <lastUpdated> as yyyyMMddHHmmss in UTC.
    const stamp = metadata?.match(/<lastUpdated>\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*<\/lastUpdated>/);
    return stamp ? toTimestamp(`${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z`) : null;
  }
  const page = await fetchWithRetry(searchUrl(library, { version }), (response) => response.json());
  const component = page?.items?.find((item) => item.version === version);
  return component ? componentDate(component) : null;
}

const allVersions = (data) => [
  ...data.lines.flatMap((line) => line.versions.map((entry) => entry.v)),
  ...(data.branchBuilds ?? []).map((entry) => entry.v),
];

async function main() {
  const { max, full, snapshots } = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const summary = await readJsonIfExists(join(ROOT, 'versions.json'));
  if (!summary) throw new Error('versions.json missing -- run fetch-versions.mjs first');
  await mkdir(join(ROOT, 'data', 'dates'), { recursive: true });

  const caches = [];
  for (const library of summary.libraries) {
    if (isMarker(library)) continue;
    const data = await readJsonIfExists(join(ROOT, 'data', `${library.slug}.json`));
    if (!data) continue;
    const previous = await readJsonIfExists(datesPath(ROOT, library.slug));
    const known = previous?.versions ?? {};
    const pending = previous?.pending ?? {};
    // Date-only entries are looked up again; the old date is the fallback.
    const legacy = {};
    for (const [version, value] of Object.entries(known)) {
      if (!isDateOnly(value)) continue;
      legacy[version] = value;
      delete known[version];
    }
    const versions = allVersions(data);
    const missing = versions.filter((v) => !(v in known));
    caches.push({ library, data, versions, known, pending, legacy, missing });
  }

  // Sweeps first: they settle most releases in a few requests each.
  const swept = new Set();
  await Promise.all(caches.map(async (cache) => {
    const releases = cache.missing.filter((v) => !isSnapshot(v));
    if (!full && releases.length <= SWEEP_THRESHOLD) return;
    try {
      const found = await sweep(cache.library);
      for (const [version, date] of Object.entries(found)) {
        if (!(version in cache.known) || full) cache.known[version] = date;
      }
      swept.add(cache.library.slug);
      process.stderr.write(`sweep ${cache.library.artifactId}: ${Object.keys(found).length} dated components\n`);
    } catch (error) {
      process.stderr.write(`FAIL  sweep ${cache.library.artifactId} -- ${error.message}\n`);
    }
  }));

  // Newest first, so a capped run dates what people look at.
  const jobs = caches
    .flatMap((cache) => cache.versions
      .filter((v) => !(v in cache.known))
      // A swept library already told us everything its index knows.
      .filter((v) => isSnapshot(v) || !swept.has(cache.library.slug))
      .map((version) => ({ cache, version })))
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, max);
  // Redeploying a SNAPSHOT changes its time; --snapshots picks that up.
  const rereads = !snapshots ? [] : caches.flatMap((cache) => cache.versions
    .filter((v) => isSnapshot(v) && cache.known[v])
    .map((version) => ({ cache, version, cached: true })));

  const notFound = [];
  let failed = 0;
  let changed = 0;
  process.stderr.write(`${jobs.length} single lookups (--max ${max}), ${rereads.length} SNAPSHOT re-reads\n`);
  await pool([...jobs, ...rereads], async ({ cache, version, cached }) => {
    try {
      const date = await lookup(cache.library, version);
      if (date) {
        if (cached && cache.known[version] !== date) changed++;
        cache.known[version] = date;
      } else if (!cached) {
        notFound.push({ cache, version });
      }
    } catch (error) {
      failed++;
      process.stderr.write(`FAIL  ${cache.library.artifactId}:${version} -- ${error.message}\n`);
    }
  });
  // Releases a sweep did not return count as one unsuccessful try.
  for (const cache of caches) {
    if (!swept.has(cache.library.slug)) continue;
    for (const version of cache.versions) {
      if (!(version in cache.known) && !isSnapshot(version)) notFound.push({ cache, version });
    }
  }
  for (const { cache, version } of notFound) {
    // An upgrade that found nothing keeps its date; it is not a missing version.
    if (version in cache.legacy) continue;
    const seen = cache.pending[version] ?? { firstSeen: new Date(now).toISOString(), tries: 0 };
    const entry = { firstSeen: seen.firstSeen, tries: seen.tries + 1 };
    if (entry.tries >= NOT_FOUND_TRIES && now - Date.parse(entry.firstSeen) >= NOT_FOUND_GRACE_MS) {
      cache.known[version] = null;
      delete cache.pending[version];
    } else {
      cache.pending[version] = entry;
    }
  }

  const newestFirst = (entries) => Object.fromEntries(entries.sort(([a], [b]) => compareVersions(b, a)));
  let written = 0;
  let undated = 0;
  for (const cache of caches) {
    const { library, data, versions, known, pending, legacy } = cache;
    for (const [version, date] of Object.entries(legacy)) if (!(version in known)) known[version] = date;
    const current = new Set(versions);
    for (const version of Object.keys(pending)) if (version in known) delete pending[version];
    const payload = {
      groupId: library.groupId,
      artifactId: library.artifactId,
      slug: library.slug,
      versions: newestFirst(Object.entries(known).filter(([version]) => current.has(version))),
    };
    const stillPending = Object.entries(pending).filter(([version]) => current.has(version));
    if (stillPending.length) payload.pending = newestFirst(stillPending);
    if (await writeIfChanged(datesPath(ROOT, library.slug), payload)) written++;
    undated += versions.filter((version) => !payload.versions[version]).length;

    if (await writeIfChanged(join(ROOT, 'data', `${library.slug}.json`), applyDates(data, payload.versions))) written++;
  }

  // The summary gets `latestDate` per line; its timestamp stays untouched,
  // as dates are not version changes.
  for (const library of summary.libraries) {
    if (isMarker(library)) continue;
    applyDates(library, await readDates(ROOT, library.slug));
  }
  if (await writeIfChanged(join(ROOT, 'versions.json'), summary)) written++;

  process.stderr.write(`\nLooked up ${jobs.length}, re-read ${rereads.length} (${changed} changed), ` +
    `not found ${notFound.length}, failed ${failed}, undated ${undated}, wrote ${written} files.\n`);
  const attempted = jobs.length + rereads.length;
  if (attempted > 0 && failed === attempted) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
