#!/usr/bin/env node
/**
 * Records which tracked libraries each released version depends on, read from
 * its POM. Run after fetch-versions.mjs; writes:
 *
 *   data/deps/<slug>.json      version -> [[depSlug, depVersion], ...]  (null = no POM)
 *   data/deps/graph.json       edges between the latest builds of every line
 *
 * Published POMs never change, so each one is fetched exactly once: versions
 * already in the cache are skipped, transient failures are retried next run.
 * Branch builds are not resolved -- they are not consumable releases.
 *
 * Each run fetches at most --max POMs (default 150), so the initial backfill
 * of several thousand versions spreads over many scheduled runs. Missing
 * versions are taken newest-first in every line, round-robin across lines and
 * libraries: the first run covers the latest build of every line, later runs
 * walk backwards.
 *
 * A 404 is not trusted straight away -- metadata can list a version before
 * its POM upload has finished. It is kept in `pending` and retried; only after
 * NOT_FOUND_TRIES attempts spanning NOT_FOUND_GRACE_MS is it recorded as null.
 *
 * SNAPSHOT versions keep their POM under a timestamped name, so their own
 * maven-metadata.xml is read first (two requests instead of one).
 *
 * Only dependencies on libraries in scripts/libraries.json are kept.
 *
 * Usage: node scripts/fetch-deps.mjs [--max <n>]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  artifactUrls,
  compareVersions,
  isDevelopmentLine,
  isSnapshot,
  parsePomDependencies,
  slugFor,
  snapshotFileVersion,
} from '../versions-lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const DEPS_DIR = join(DATA_DIR, 'deps');

const CONCURRENCY = 8;
const TIMEOUT_MS = 20000;
const ATTEMPTS = 3;
const DEFAULT_MAX = 150;
const NOT_FOUND_TRIES = 3;
const NOT_FOUND_GRACE_MS = 24 * 60 * 60 * 1000;
/** Marks cache files written with the timestamped SNAPSHOT lookup. */
const SNAPSHOT_LOOKUP = 'timestamped';

function parseMax(argv) {
  const index = argv.indexOf('--max');
  if (index === -1) return DEFAULT_MAX;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--max needs a non-negative integer, got "${argv[index + 1]}"`);
  return value;
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Response text, null on 404, throws on anything else after retries. */
async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}

/**
 * POM text for one version, null on 404. A SNAPSHOT is resolved through its
 * version metadata; without that metadata (a non-unique snapshot repository)
 * the plain name is tried.
 */
async function fetchPom(library, version) {
  const urls = artifactUrls(library, version);
  if (!isSnapshot(version)) return fetchText(urls.pom);
  const metadata = await fetchText(urls.versionMetadata);
  const fileVersion = metadata && snapshotFileVersion(metadata, 'pom');
  return fetchText(fileVersion ? urls.pomFor(fileVersion) : urls.pom);
}

async function pool(items, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

async function writeIfChanged(path, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (existsSync(path) && (await readFile(path, 'utf8')) === text) return false;
  await writeFile(path, text);
  return true;
}

async function main() {
  const max = parseMax(process.argv.slice(2));
  const now = Date.now();
  const configured = JSON.parse(await readFile(join(ROOT, 'scripts', 'libraries.json'), 'utf8'));
  const slugByCoordinate = new Map(configured.map((library) => [
    `${library.groupId}:${library.artifactId}`, slugFor(library),
  ]));

  const summary = await readJsonIfExists(join(ROOT, 'versions.json'));
  if (!summary) throw new Error('versions.json missing -- run fetch-versions.mjs first');

  await mkdir(DEPS_DIR, { recursive: true });

  const caches = new Map();
  const missing = [];
  for (const [rank, library] of summary.libraries.entries()) {
    const full = await readJsonIfExists(join(DATA_DIR, `${library.slug}.json`));
    if (!full) continue;
    const previousFile = await readJsonIfExists(join(DEPS_DIR, `${library.slug}.json`));
    const previous = previousFile?.versions ?? {};
    const previousPending = previousFile?.pending ?? {};
    // Files from before the timestamped lookup may hold SNAPSHOTs recorded
    // as having no POM because the wrong file name was requested. One retry
    // each; once the marker is written, a null is final again.
    const retrySnapshots = previousFile?.snapshotLookup !== SNAPSHOT_LOOKUP;
    const released = new Set();
    const versions = {};
    const pending = {};
    for (const line of full.lines) {
      line.versions.forEach((entry, indexInLine) => {
        released.add(entry.v);
        const stale = retrySnapshots && previous[entry.v] === null && isSnapshot(entry.v);
        if (entry.v in previous && !stale) {
          versions[entry.v] = previous[entry.v];
          return;
        }
        if (previousPending[entry.v]) pending[entry.v] = previousPending[entry.v];
        missing.push({ library, version: entry.v, indexInLine, dev: isDevelopmentLine(line.line), line: line.line, rank });
      });
    }
    caches.set(library.slug, { library, released, versions, pending });
  }

  // Newest of every line first, real release lines before dev lines, newer
  // lines before older ones, then libraries.json order.
  missing.sort((a, b) =>
    a.indexInLine - b.indexInLine ||
    Number(a.dev) - Number(b.dev) ||
    compareVersions(b.line, a.line) ||
    a.rank - b.rank);
  const jobs = missing.slice(0, max);

  process.stderr.write(`${missing.length} POMs missing, fetching ${jobs.length} (--max ${max})\n`);
  let failed = 0;
  let notFound = 0;
  await pool(jobs, async ({ library, version }) => {
    const cache = caches.get(library.slug);
    try {
      const pom = await fetchPom(library, version);
      if (pom === null) {
        notFound++;
        const seen = cache.pending[version] ?? { firstSeen: new Date(now).toISOString(), tries: 0 };
        const entry = { firstSeen: seen.firstSeen, tries: seen.tries + 1 };
        if (entry.tries >= NOT_FOUND_TRIES && now - Date.parse(entry.firstSeen) >= NOT_FOUND_GRACE_MS) {
          cache.versions[version] = null;
          delete cache.pending[version];
        } else {
          cache.pending[version] = entry;
        }
        return;
      }
      cache.versions[version] = parsePomDependencies(pom)
        .map((dep) => [slugByCoordinate.get(`${dep.groupId}:${dep.artifactId}`), dep.version])
        .filter(([slug, depVersion]) => slug && depVersion && slug !== library.slug);
      delete cache.pending[version];
    } catch (error) {
      failed++;
      process.stderr.write(`FAIL  ${library.groupId}:${library.artifactId}:${version} -- ${error.message}\n`);
    }
  });

  const newestFirst = (entries) => Object.fromEntries(entries.sort(([a], [b]) => compareVersions(b, a)));
  let written = 0;
  for (const { library, released, versions, pending } of caches.values()) {
    // Versions gone from the metadata drop out of both maps.
    const payload = {
      groupId: library.groupId,
      artifactId: library.artifactId,
      slug: library.slug,
      snapshotLookup: SNAPSHOT_LOOKUP,
      versions: newestFirst(Object.entries(versions).filter(([version]) => released.has(version))),
    };
    const stillPending = Object.entries(pending).filter(([version]) => released.has(version));
    if (stillPending.length) payload.pending = newestFirst(stillPending);
    if (await writeIfChanged(join(DEPS_DIR, `${library.slug}.json`), payload)) written++;
  }

  // Per line: what the latest build of each library declares. Small enough
  // to load with the page.
  const lines = {};
  for (const library of summary.libraries) {
    for (const { line, latest } of library.lines ?? []) {
      lines[line] ??= { latest: {}, edges: [] };
      lines[line].latest[library.slug] = latest;
      for (const [depSlug, depVersion] of caches.get(library.slug)?.versions[latest] ?? []) {
        lines[line].edges.push([library.slug, depSlug, depVersion]);
      }
    }
  }
  if (await writeIfChanged(join(DEPS_DIR, 'graph.json'), { lines })) written++;

  let left = 0;
  for (const { released, versions } of caches.values()) {
    for (const version of released) if (!(version in versions)) left++;
  }
  process.stderr.write(
    `\nFetched ${jobs.length - failed - notFound}, 404 ${notFound}, failed ${failed}, ` +
    `still missing ${left}, wrote ${written} files.\n`,
  );
  if (jobs.length > 0 && failed === jobs.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
